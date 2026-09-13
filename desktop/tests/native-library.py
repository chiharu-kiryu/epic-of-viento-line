"""Exercise the real library buttons and GTK pickers using isolated data.

python3 desktop/tests/native-library.py /path/to/tauri-driver /path/to/WebKitWebDriver /path/to/viento-studio
Requires xvfb-run, dbus-run-session, ffmpeg, fusermount3, xclip and xdotool (or
VIENTO_TEST_XDOTOOL). VIENTO_TEST_SCREENSHOT_DIR retains screenshots and logs.
"""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import wave
import zipfile
from native_export_workflow import exercise_editor_exports


def wait_for(action, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            value = action()
            if value:
                return value
        except Exception as error:
            last = error
        time.sleep(.1)
    raise AssertionError(f'Timed out: {last}')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def authored_files(root):
    return {str(file.relative_to(root)): file.read_bytes() for file in root.rglob('*')
            if file.is_file() and '.viento' not in file.relative_to(root).parts}


with tempfile.TemporaryDirectory(prefix='viento-native-library-') as scratch:
    root = Path(scratch)
    data, config, runtime = [root / name for name in ['data', 'config', 'runtime']]
    runtime.mkdir(mode=0o700)
    parent, restored_parent = root / '位置 A #100%', root / '恢复位置 B'
    parent.mkdir()
    restored_parent.mkdir()
    library_file = data / 'io.viento.studio/library.json'
    screenshots = Path(os.environ.get('VIENTO_TEST_SCREENSHOT_DIR', root / 'screenshots')).resolve()
    screenshots.mkdir(parents=True, exist_ok=True)
    xdotool = os.environ.get('VIENTO_TEST_XDOTOOL') or shutil.which('xdotool')
    assert xdotool, 'xdotool is required'
    environment = dict(os.environ, XDG_DATA_HOME=str(data), XDG_CONFIG_HOME=str(config),
                       XDG_CACHE_HOME=str(root / 'cache'), XDG_RUNTIME_DIR=str(runtime),
                       GSETTINGS_BACKEND='memory', GIO_USE_VFS='local', GVFS_DISABLE_FUSE='1',
                       WEBKIT_DISABLE_DMABUF_RENDERER='1')
    for key in ['SESSION_MANAGER', 'GNOME_KEYRING_CONTROL', 'SSH_AUTH_SOCK', 'WAYLAND_DISPLAY']:
        environment.pop(key, None)
    port, native_port = free_port(), free_port()
    webdriver = http.client.HTTPConnection('127.0.0.1', port, timeout=45)
    log = (screenshots / 'native-driver.log').open('w')
    process = subprocess.Popen(['dbus-run-session', '--', 'xvfb-run', '-a', sys.argv[1],
                                '--native-driver', sys.argv[2], '--port', str(port),
                                '--native-port', str(native_port)], env=environment,
                               stdout=log, stderr=log, start_new_session=True)
    session, editor, picker_env = None, None, None

    def request(method, url, payload=None):
        try:
            webdriver.request(method, url, body=None if payload is None else json.dumps(payload).encode(),
                              headers={'Content-Type': 'application/json'})
            response = webdriver.getresponse()
            content = response.read()
        except (OSError, http.client.HTTPException):
            webdriver.close()
            raise
        if response.status >= 400:
            raise AssertionError(content.decode())
        # A successful script may itself return an object with an `error` key.
        # Only the HTTP status identifies a WebDriver protocol failure.
        return json.loads(content).get('value')

    def command(method, url, payload=None):
        return request(method, f'/session/{session}{url}', payload)

    def script(code, *args):
        return command('POST', '/execute/sync', {'script': code, 'args': list(args)})

    def click(selector):
        element = command('POST', '/element', {'using': 'css selector', 'value': selector})
        command('POST', f'/element/{element["element-6066-11e4-a52e-4f735466cecf"]}/click', {})

    def screenshot(name):
        (screenshots / f'{name}.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))

    def recent():
        return json.loads(library_file.read_text())['recent'] if library_file.exists() else []

    def idle(text=None, error=False):
        wait_for(lambda: script('return !document.body.classList.contains("busy")'))
        if text:
            wait_for(lambda: script('return document.querySelector("#status").textContent.includes(arguments[0])', text))
        assert script('return document.querySelector("#status").classList.contains("error")') == error

    def isolated_display():
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                env = dict(item.split(b'=', 1) for item in (proc / 'environ').read_bytes().split(b'\0') if b'=' in item)
                if (proc / 'comm').read_text().strip() == 'tauri-driver' and env.get(b'XDG_DATA_HOME') == str(data).encode():
                    assert b'XAUTHORITY' in env and b'DISPLAY' in env
                    return {key.decode(): value.decode() for key, value in env.items()}
            except (OSError, UnicodeDecodeError):
                pass
        raise AssertionError('Isolated test display not found')

    def native_window(title):
        result = subprocess.run([xdotool, 'search', '--onlyvisible', '--name', '^' + re.escape(title) + '$'],
                                env=picker_env, capture_output=True, text=True, timeout=10)
        return result.stdout.splitlines()[-1] if result.returncode == 0 and result.stdout.strip() else None

    def native_key(window, *keys):
        subprocess.run([xdotool, 'windowfocus', '--sync', window], env=picker_env, check=True, capture_output=True, timeout=10)
        subprocess.run([xdotool, 'key', '--clearmodifiers', *keys], env=picker_env, check=True, capture_output=True, timeout=10)

    def native_child_dialog(parent):
        windows = subprocess.check_output([xdotool, 'search', '--onlyvisible', '--name', '.*'], env=picker_env, timeout=10).decode().splitlines()
        for child in windows:
            result = subprocess.run(['xprop', '-id', child, 'WM_TRANSIENT_FOR'], env=picker_env,
                                    capture_output=True, text=True, timeout=5)
            match = re.search(r'window id # (0x[0-9a-f]+)', result.stdout)
            if match and int(match[1], 16) == int(parent):
                return child
        return None

    def native_screenshot(window, name):
        geometry = dict(line.split('=', 1) for line in subprocess.check_output([xdotool, 'getwindowgeometry', '--shell', window], env=picker_env, timeout=10).decode().splitlines())
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0',
                        '-video_size', f'{geometry["WIDTH"]}x{geometry["HEIGHT"]}',
                        '-i', f'{picker_env["DISPLAY"]}+{geometry["X"]},{geometry["Y"]}',
                        '-frames:v', '1', str(screenshots / f'{name}.png')],
                       env=picker_env, check=True, capture_output=True, timeout=10)

    def choose(title, path=None, shot=None, after_submit=None):
        window = wait_for(lambda: native_window(title))
        if shot:
            native_screenshot(window, shot)
        if path is None:
            native_key(window, 'Escape')
        else:
            native_key(window, 'ctrl+l', 'ctrl+a')
            # XTest keymap injection can lose non-ASCII characters. Paste UTF-8
            # on the isolated Xvfb clipboard, leaving the user's clipboard alone.
            subprocess.run(['xclip', '-selection', 'clipboard', '-in'], input=str(path).encode(),
                           env=picker_env, check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=10)
            native_key(window, 'ctrl+v')
            # GTK receives clipboard contents asynchronously, after the key
            # event; do not submit the location before the paste arrives.
            time.sleep(.2)
            if after_submit:
                # For existing files GTK can consume Enter as filename
                # completion. Click the Save button observed at bottom right.
                geometry = dict(line.split('=', 1) for line in subprocess.check_output([xdotool, 'getwindowgeometry', '--shell', window], env=picker_env, timeout=10).decode().splitlines())
                subprocess.run([xdotool, 'mousemove', '--window', window, str(int(geometry['WIDTH']) - 48), str(int(geometry['HEIGHT']) - 24), 'click', '1'], env=picker_env, check=True, capture_output=True, timeout=10)
                native_screenshot(window, 'export-before-confirmation')
                after_submit(window)
            else:
                native_key(window, 'Return')
        try:
            wait_for(lambda: native_window(title) is None, timeout=10)
        except AssertionError:
            native_screenshot(window, 'picker-failure')
            raise

    def create_form(name):
        click('#createBtn')
        script('const input=document.querySelector("#workspaceName");input.value=arguments[0];input.dispatchEvent(new Event("input",{bubbles:true}));return true', name)
        click('#createForm button[type="submit"]')

    def enter_editor():
        global editor
        handles = wait_for(lambda: value if len(value := command('GET', '/window/handles')) == 2 else None)
        editor = next(handle for handle in handles if handle != main)
        command('POST', '/window', {'handle': editor})
        wait_for(lambda: script('const button=document.querySelector("#docCreateBtn");return button?.textContent === "新建文档" && !button.disabled'))

    def home():
        started = script('const started=Date.now();setTimeout(() => document.querySelector(".topbar-identity > button:first-child").click(),100);return started')
        command('POST', '/window', {'handle': main})
        # Closing/launching also emit library-changed. Wait for this return's
        # event AND the resulting rows, not a cumulative event count.
        wait_for(lambda: script('return window.libraryReturnedAt >= arguments[0] && window.libraryRenderedAt >= arguments[0] && !document.querySelector("#activeSession").hidden', started))
        idle()

    def close_clean_editor():
        home()
        click('#closeEditorBtn')
        wait_for(lambda: len(command('GET', '/window/handles')) == 1)
        command('POST', '/window', {'handle': main})
        wait_for(lambda: script('return document.querySelector("#activeSession").hidden'))
        idle()

    def resume():
        # As with returning home, WebKit cannot reliably reply to a click whose
        # handler hides the current WebView. Dispatch the real event afterward.
        script('setTimeout(() => document.querySelector("#resumeBtn").click(),100);return true')
        command('POST', '/window', {'handle': editor})
        wait_for(lambda: native_window(f"{recent()[0]['name']} · Viento Studio {release}"))

    def switch_language(language):
        click('#settingsBtn')
        script('const select=document.querySelector("#languageSelect");select.value=arguments[0];select.dispatchEvent(new Event("change",{bubbles:true}));return true', language)
        wait_for(lambda: script('return document.documentElement.lang===arguments[0] && !document.querySelector("#languageSelect").disabled', language))
        click('#settingsDialog button[type="submit"]')

    try:
        wait_for(lambda: request('GET', '/status'))
        session = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'wry',
                          'unhandledPromptBehavior': 'ignore', 'tauri:options': {'application': str(Path(sys.argv[3]).resolve())}}}})['sessionId']
        main = command('GET', '/window')
        picker_env = isolated_display()
        wait_for(lambda: script('return document.querySelector("#emptyState")?.hidden === false && document.querySelector("#status").textContent === "作品库已准备好。"'))
        idle()
        release = script('return document.querySelector("#appVersion").textContent')
        script('new MutationObserver(()=>window.libraryRenderedAt=Date.now()).observe(document.querySelector("#workspaces"),{childList:true});window.__TAURI__.event.listen("library-changed",()=>window.libraryReturnedAt=Date.now()).then(()=>window.listenerReady=true);return true')
        wait_for(lambda: script('return window.listenerReady'))
        screenshot('library-empty')

        click('#createBtn')
        click('#cancelCreateBtn')
        assert not recent() and not list(parent.iterdir())
        create_form('取消的新作品')
        choose('选择新作品库的保存位置', shot='library-create-picker')
        idle('已取消')
        assert not recent() and not list(parent.iterdir())
        create_form('../不允许的名称')
        choose('选择新作品库的保存位置', parent)
        idle('最多 80 字', error=True)
        assert not recent() and not list(parent.iterdir())
        print('PASS: cancel name form / native creation picker; invalid name reports failure without creating files; retry remains available', flush=True)

        create_form('原生作品 #100%')
        choose('选择新作品库的保存位置', parent)
        enter_editor()
        workspace = Path(recent()[0]['path'])
        assert workspace.parent == parent and recent()[0]['name'] == '原生作品 #100%', {'expectedParent': str(parent), 'actual': recent()[0]}
        manifest = json.loads((workspace / 'workspace.json').read_text())
        assert manifest['version'] == 3 and len(manifest['documentTypes']) == 6
        assert not list((workspace / 'documents').iterdir()) and len(list((workspace / 'templates').iterdir())) == 6
        wait_for(lambda: script('return document.body.innerText.includes(arguments[0])', recent()[0]['name']))
        screenshot('library-created-editor')
        home()
        before = authored_files(parent)
        records_before = library_file.read_bytes()
        if not script('return document.querySelector("#createBtn").disabled'):
            create_form('不应提前创建的作品')
            choose('选择新作品库的保存位置', parent)
            idle('请先保存并关闭', error=True)
            assert authored_files(parent) == before and library_file.read_bytes() == records_before, 'Created another project before refusing to switch away from the active editor'
        for selector in ['#createBtn', '#openBtn', '#importBtn']:
            assert script('return document.querySelector(arguments[0]).disabled', selector), selector
        # The host must enforce this even if an old UI sends a command.
        for name, args in [('new_workspace', {'name': '禁止创建'}), ('choose_workspace', {}), ('restore_workspace', {})]:
            script('window.guardResult=null;window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(()=>window.guardResult={ok:true},error=>window.guardResult={error:String(error)});return true', name, args)
            result = wait_for(lambda: script('return window.guardResult'))
            assert '请先保存并关闭' in result.get('error', ''), result
        assert authored_files(parent) == before and library_file.read_bytes() == records_before
        screenshot('library-active-guard')
        resume()
        close_clean_editor()
        print('PASS: real GTK creation → empty generic editor; active session blocks create/open/import before any picker, registration or file creation', flush=True)

        source = workspace / 'documents/characters/旅人 #100%.md'
        source.parent.mkdir()
        source.write_bytes('\ufeff# 旅人\r\n\r\n身份：旅人\r\n\r\n![参考](assets/media/images/图%20%23100%25.svg)\r\n'.encode())
        image = workspace / 'assets/media/images/图 #100%.svg'
        image.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>')
        with wave.open(str(workspace / 'assets/media/audio/声音.wav'), 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(8000); audio.writeframes(b'\0\0' * 80)
        (workspace / 'assets/空文件.bin').write_bytes(b'')
        original_source = source.read_bytes()
        click('#openBtn')
        choose('选择作品项目文件夹')
        idle('已取消')
        invalid = root / '不是作品'; invalid.mkdir()
        click('#openBtn')
        choose('选择作品项目文件夹', invalid)
        idle(error=True)
        assert not list(invalid.iterdir()) and len(recent()) == 1
        click('#openBtn')
        choose('选择作品项目文件夹', workspace, 'library-open-picker')
        enter_editor()
        wait_for(lambda: script('return document.querySelectorAll("#docList button[data-path-key]").length===1'))
        assert len(recent()) == 1 and source.read_bytes() == original_source
        expected = authored_files(workspace)
        home()
        backup_button = '.workspace-actions button:nth-child(2)'
        click(backup_button)
        choose('导出已保存的正文、模板和素材')
        idle('已取消导出')
        assert authored_files(workspace) == expected
        click(backup_button)
        forbidden = workspace / 'assets/不能写入.viento.zip'
        choose('导出已保存的正文、模板和素材', forbidden)
        idle('之外', error=True)
        assert not forbidden.exists() and authored_files(workspace) == expected
        archive = root / '备份 #100%.viento.zip'
        click(backup_button)
        choose('导出已保存的正文、模板和素材', archive, 'library-backup-picker')
        idle('备份已保存到')
        with zipfile.ZipFile(archive) as package:
            assert package.testzip() is None
            descriptor = json.loads(package.read('manifest.json'))
            for item in descriptor['files']:
                content = package.read(item['path'])
                assert len(content) == item['size'] and hashlib.sha256(content).hexdigest() == item['sha256']
            assert all(package.read(path) == contents for path, contents in expected.items())
            assert not any('/cache/' in item for item in package.namelist())
        assert authored_files(workspace) == expected
        screenshot('library-backup-complete')
        resume()
        close_clean_editor()
        print('PASS: open cancellation / invalid folder / successful open and deduplication; backup cancel / forbidden destination / retry → verified complete ZIP', flush=True)

        settings_before = library_file.read_bytes()
        click('#importBtn')
        choose('选择 Viento 迁移包')
        idle('已取消')
        click('#importBtn')
        choose('选择 Viento 迁移包', archive)
        choose('选择导入位置（会创建新文件夹）')
        idle('已取消')
        assert not list(restored_parent.iterdir()) and library_file.read_bytes() == settings_before
        corrupt = root / '损坏包.viento.zip'
        with zipfile.ZipFile(archive) as original, zipfile.ZipFile(corrupt, 'w') as damaged:
            for item in original.infolist():
                content = original.read(item.filename)
                if item.filename == str(source.relative_to(workspace)):
                    content += b'corrupted'
                damaged.writestr(item, content)
        click('#importBtn')
        choose('选择 Viento 迁移包', corrupt)
        choose('选择导入位置（会创建新文件夹）', restored_parent)
        idle(error=True)
        assert not list(restored_parent.iterdir()) and library_file.read_bytes() == settings_before
        screenshot('library-invalid-archive')
        click('#importBtn')
        choose('选择 Viento 迁移包', archive, 'library-import-picker')
        choose('选择导入位置（会创建新文件夹）', restored_parent, 'library-restore-picker')
        enter_editor()
        restored = Path(recent()[0]['path'])
        assert restored.parent == restored_parent and restored != workspace
        assert authored_files(restored) == expected and authored_files(workspace) == expected
        assert len(recent()) == 2
        wait_for(lambda: script('return document.querySelectorAll("#docList button[data-path-key]").length===1'))
        click('#docList button[data-path-key]')
        wait_for(lambda: script('return document.querySelector("#docTitle").textContent.includes("旅人") && document.querySelector(".document-section img")?.naturalWidth===16'))
        screenshot('library-restored-editor')
        if os.environ.get('VIENTO_TEST_EDITOR_EXPORT'):
            exercise_editor_exports(root=root, workspace=restored, expected=expected,
                                    click=click, script=script, wait_for=wait_for,
                                    choose=choose, native_window=native_window,
                                    native_key=native_key, native_screenshot=native_screenshot,
                                    native_child_dialog=native_child_dialog, screenshot=screenshot,
                                    switch_language=switch_language)
            assert authored_files(restored) == expected and authored_files(workspace) == expected
        close_clean_editor()
        print('PASS: cancel both import pickers → no writes; damaged archive → rollback and records preserved; retry → auto-open restored project with byte-identical sources/templates/metadata/media', flush=True)

        switch_language('en')
        click('#openBtn')
        choose('Choose a project folder', shot='library-open-picker-en')
        idle('Cancelled')
        screenshot('library-final-en')
        print('PASS: English native folder picker and cancellation; two independent project copies remain registered; all test processes and files are isolated', flush=True)
    except Exception:
        if session:
            try:
                screenshot('library-failure')
                print('Library failure:', script('return document.body.innerText')[:2000], flush=True)
            except Exception:
                pass
        raise
    finally:
        if session:
            try:
                request('DELETE', f'/session/{session}')
            except Exception:
                pass
        webdriver.close()
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        log.close()
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            target = line.split()[4]
            if target.startswith(str(runtime) + '/'):
                detached = subprocess.run(['fusermount3', '-uz', target], capture_output=True, text=True, timeout=10)
                remaining = {entry.split()[4] for entry in Path('/proc/self/mountinfo').read_text().splitlines()}
                if detached.returncode and target in remaining:
                    raise RuntimeError(detached.stderr)
