"""Editor export/save checks for the isolated native-library.py session."""
import hashlib
import json
import zipfile


def exercise_editor_exports(*, root, workspace, expected, click, script, wait_for,
                            choose, native_window, native_key, native_screenshot,
                            native_child_dialog, screenshot, switch_language):
    cache = workspace / '.viento/cache/exports'
    title = '保存导出文件'

    def ready_message(text):
        wait_for(lambda: script('return document.querySelector("#docExportMessage").textContent.includes(arguments[0]) && !document.querySelector("#docExportCloseBtn").disabled', text))
        assert script('return !document.querySelector("#docEditPanel").classList.contains("is-busy")')

    def begin(kind):
        click('#docExportBtn')
        script('const radio=document.querySelector(`input[name="exportKind"][value="${arguments[0]}"]`);radio.checked=true;radio.dispatchEvent(new Event("change",{bubbles:true}));return true', kind)
        click('#docExportStartBtn')
        wait_for(lambda: native_window(title))
        assert script('return document.querySelector("#docExportCloseBtn").disabled && document.querySelector("#docExportOptions").disabled')

    def prepared():
        files = list(cache.glob('*/payload.zip'))
        assert len(files) == 1, files
        return files[0], files[0].read_bytes()

    def expire(file):
        # Exercise the same cleanup used by the TTL, without waiting 15 min.
        # This is the real authenticated release endpoint, not a mocked server.
        script('window.exportReleased=null;fetch("/api/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"release",id:arguments[0]})}).then(r=>window.exportReleased=r.status);return true', file.parent.name)
        wait_for(lambda: script('return window.exportReleased===200'))
        wait_for(lambda: not file.parent.exists())

    def verify_archive(output, original, full=False):
        assert output.read_bytes() == original
        with zipfile.ZipFile(output) as package:
            assert package.testzip() is None
            descriptor = json.loads(package.read('manifest.json'))
            for entry in descriptor['files']:
                content = package.read(entry['path'])
                assert len(content) == entry['size']
                assert hashlib.sha256(content).hexdigest() == entry['sha256']
            if full:
                assert descriptor['format'] == 'viento-archive'
                assert all(package.read(name) == content for name, content in expected.items())
            else:
                html = package.read('index.html').decode()
                assert '旅人' in html and '<img ' in html

    begin('document')
    file, original = prepared()
    expire(file)
    output = root / '等待后保存 #100%.zip'
    choose(title, output)
    ready_message('已保存到')
    verify_archive(output, original)
    screenshot('export-save-after-expiry')
    click('#docExportCloseBtn')
    print('PASS: real GTK save remains valid after prepared cache is released; saved share ZIP is byte-identical and includes source/image', flush=True)

    switch_language('en')
    title = 'Save exported file'
    begin('workspace')
    file, _ = prepared()
    choose(title, shot='export-save-picker-en')
    ready_message('Save cancelled')
    expire(file)
    click('#docExportSaveBtn')
    ready_message('expired')
    assert script('return !document.querySelector("#docExportStartBtn").disabled && document.querySelector("#docExportSaveBtn").hidden')
    screenshot('export-expired-regenerate')
    click('#docExportStartBtn')
    wait_for(lambda: native_window(title))
    file, original = prepared()
    forbidden = workspace / 'assets/不可覆盖.zip'
    choose(title, forbidden)
    ready_message('之外')
    assert not forbidden.exists() and file.read_bytes() == original
    screenshot('export-forbidden-retry')
    print('PASS: cancel → expiry → regenerate in the same English dialog; invalid destination preserves a retryable package', flush=True)

    output = root / '已有备份 #100%.zip'
    output.write_bytes(b'previous backup must survive cancellation')

    def overwrite(accept, chooser):
        # GTK's overwrite prompt is identified by its parent picker, independent
        # of title and Xvfb/window-manager focus behavior.
        confirm = wait_for(lambda: native_child_dialog(chooser), timeout=10)
        native_screenshot(confirm, 'export-overwrite-confirm')
        native_key(confirm, 'alt+r' if accept else 'Escape')
        wait_for(lambda: native_child_dialog(chooser) is None)
        if not accept:
            native_key(wait_for(lambda: native_window(title)), 'Escape')

    click('#docExportSaveBtn')
    choose(title, output, after_submit=lambda chooser: overwrite(False, chooser))
    ready_message('Save cancelled')
    assert output.read_bytes() == b'previous backup must survive cancellation'
    assert file.read_bytes() == original
    click('#docExportSaveBtn')
    choose(title, output, after_submit=lambda chooser: overwrite(True, chooser))
    ready_message('Saved to')
    verify_archive(output, original, full=True)
    screenshot('export-overwrite-complete')
    click('#docExportCloseBtn')
    wait_for(lambda: not list(cache.iterdir()))
    switch_language('zh-CN')
    print('PASS: native overwrite cancel keeps the existing file; explicit replace publishes the exact complete project; staging is cleared', flush=True)
