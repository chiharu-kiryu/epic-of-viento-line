"""Run against the actual Linux Tauri/WebKit app using the W3C WebDriver protocol.

Usage: python3 desktop/tests/native-smoke.py /path/to/tauri-driver /path/to/WebKitWebDriver [app]
Build with `npm run desktop:build -- --debug --no-bundle` first, or pass a packaged executable.
The test creates isolated settings, workspace data and package extraction output.
Set VIENTO_TEST_SCREENSHOT_DIR explicitly to retain screenshots after the test.
Media checks require ffmpeg with PNG, VP8 and H.264 encoders.
Set VIENTO_TEST_GENERIC_CREATE to the workspace-archive example executable to
exercise new generic projects, project templates and a complete backup restore.
"""
import base64
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
import hashlib

ROOT = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_for(action, timeout=30):
    last = None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = action()
            if value:
                return value
        except Exception as error:
            last = error
        time.sleep(.15)
    raise AssertionError(f'Timed out: {last}')


with tempfile.TemporaryDirectory(prefix='viento-native-e2e-') as directory:
    test_root = Path(directory)
    imported_image = test_root / '角色参考 #1.png'
    imported_webm = test_root / '动作预览.webm'
    imported_mp4 = test_root / '动作预览.mp4'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x76b6a6:s=320x180', '-frames:v', '1', str(imported_image)], check=True, timeout=30)
    for file, codec in [(imported_webm, ['-c:v', 'libvpx', '-b:v', '250k']), (imported_mp4, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])]:
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '3', *codec, str(file)], check=True, timeout=30)
    data = test_root / 'data'
    app_data = data / 'io.viento.studio'
    workspace = app_data / 'workspaces' / '桌面流程验证'
    workspace.mkdir(parents=True)
    (workspace / 'design-data' / 'backstory').mkdir(parents=True)
    (workspace / 'assets').mkdir()
    (workspace / 'assets/concept').mkdir()
    (workspace / 'assets/concept/图#1.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>')
    (workspace / 'data-template').mkdir()
    private = workspace / '.viento'
    private.mkdir()
    identifier = str(uuid.uuid4())
    manifest = dict(format='viento-workspace', version=2, id=identifier, name='桌面流程验证', createdAt=1, paths=dict(documents='design-data', templates='data-template', metadata='metadata'), assetStores=dict(main=dict(path='assets')))
    (workspace / 'workspace.json').write_text(json.dumps(manifest))
    guard = dict(format='viento-workspace', version=2, id='00000000-0000-0000-0000-000000000000', name='Viento Studio 0.2+ required', createdAt=0, compatibilityGuard=True)
    (private / 'workspace.json').write_text(json.dumps(guard, indent=2) + '\n')
    source = workspace / 'design-data' / 'backstory' / '原生测试.md'
    original = '\ufeff# 原生桌面测试\r\n\r\n从独立作品库读取的正文。\r\n\r\n![素材](assets/concept/图%231.svg)\r\n'
    source.write_bytes(original.encode())
    item_source = workspace / 'design-data/design-item/合成/法术/邪魔匕首.md'
    item_source.parent.mkdir(parents=True)
    item_original = '# 邪魔匕首\n\n属性：\n+15% 技能伤害\n+350 魔法上限\n+20 移动速度\n\n价格：4000\n\n合成：原木法杖 + 风灵挂饰 + 星之眼 + 1000\n'
    item_source.write_text(item_original)
    character_source = workspace / 'design-data/characters/测试角色.md'
    character_source.parent.mkdir()
    character_original = '# 测试角色\n\n## 自定义信息\n灵魂数量：0\n身份：旅人\n'
    character_source.write_text(character_original)
    biography_source = workspace / 'design-data/stories/测试角色经历.md'
    biography_source.parent.mkdir()
    biography_original = '# 测试角色经历\n\n只在背景中的暗号。\n'
    biography_source.write_text(biography_original)
    memory_source = workspace / 'design-data/stories/童年片段.md'
    memory_source.write_text('# 童年片段\n\n初次相遇。\n')
    descriptors = workspace / 'metadata/documents'
    descriptors.mkdir(parents=True)
    character_id, biography_id, memory_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    for doc_id, file, doc_type, profile, relations in [
        (character_id, character_source, 'character', 'structured', []),
        (biography_id, biography_source, 'story', 'prose', [dict(kind='part-of', targetId=character_id, slot='背景故事')]),
        (memory_id, memory_source, 'story', 'prose', [dict(kind='part-of', targetId=biography_id, slot='经历片段')]),
    ]:
        record = dict(format='viento-document', version=1, id=doc_id, sourcePath=str(file.relative_to(workspace)), documentType=doc_type, parserProfile=profile, relations=relations, assetBindings=[])
        (descriptors / f'{doc_id}.json').write_text(json.dumps(record))
    generic_tool = os.environ.get('VIENTO_TEST_GENERIC_CREATE')
    if generic_tool:
        # The CLI calls the same Rust creation function as the native picker.
        # Replace only the temporary fixture created by this test above.
        shutil.rmtree(workspace)
        created = subprocess.run([generic_tool, 'create', str(workspace.parent), '通用 OC 项目'], capture_output=True, text=True, check=True, timeout=30)
        workspace = Path(json.loads(created.stdout)['root'])
        private = workspace / '.viento'
        manifest = json.loads((workspace / 'workspace.json').read_text())
        assert manifest['version'] == 3
        assert not list((workspace / 'documents').iterdir())
        assert not (workspace / 'design-data').exists() and not (workspace / 'data-template').exists()
        assert len(list((workspace / 'templates').iterdir())) == 6
        manifest['documentTypes'].append(dict(id='species', label='种族', directory='species', parserProfile='structured', template='species.yaml'))
        (workspace / 'workspace.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        (workspace / 'templates/species.yaml').write_text('title: 新建种族\n灵魂数量: 2\n起源: 由项目自己的模板定义。\n')
        identifier = manifest['id']
    recent = dict(path=str(workspace), name=manifest['name'], id=identifier, lastOpened=int(time.time() * 1000))
    (app_data / 'library.json').write_text(json.dumps(dict(recent=[recent])))
    environment = dict(os.environ, XDG_DATA_HOME=str(data), XDG_CONFIG_HOME=str(test_root / 'config'), XDG_CACHE_HOME=str(test_root / 'cache'), WEBKIT_DISABLE_DMABUF_RENDERER='1')
    application = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else ROOT / 'src-tauri/target/debug/viento-studio'
    if application.suffix == '.AppImage':
        # WebDriver terminates the process group, which can kill an AppImage's
        # extract-and-run wrapper before it removes hundreds of MB from /tmp.
        # Own the extraction directory so the outer context always cleans it.
        environment.pop('APPIMAGE_EXTRACT_AND_RUN', None)
        extraction = test_root / 'application'
        extraction.mkdir()
        subprocess.run([str(application), '--appimage-extract'], cwd=extraction,
                       env=environment, stdout=subprocess.DEVNULL, check=True, timeout=120)
        application = extraction / 'squashfs-root/AppRun'
    screenshots = Path(os.environ.get('VIENTO_TEST_SCREENSHOT_DIR', test_root / 'screenshots')).resolve()
    screenshots.mkdir(parents=True, exist_ok=True)
    port, native_port = free_port(), free_port()
    endpoint = f'http://127.0.0.1:{port}'
    log = open('/tmp/viento-native-driver.log', 'w')
    process = subprocess.Popen(['dbus-run-session', '--', 'xvfb-run', '-a', sys.argv[1], '--native-driver', sys.argv[2], '--port', str(port), '--native-port', str(native_port)], env=environment, stdout=log, stderr=log, start_new_session=True)
    session = None
    library_returns = 0

    def request(method, url, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(endpoint + url, data=body, headers={'Content-Type': 'application/json'}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                result = json.load(response).get('value')
        except urllib.error.HTTPError as error:
            raise AssertionError(error.read().decode()) from error
        if isinstance(result, dict) and result.get('error'):
            raise AssertionError(result)
        return result

    def command(method, url, payload=None):
        return request(method, f'/session/{session}{url}', payload)

    def script(source, *args):
        return command('POST', '/execute/sync', dict(script=source, args=list(args)))

    def switch_language(language):
        click('#settingsBtn')
        wait_for(lambda: script('return document.querySelector("#settingsDialog").open'))
        script('const select=document.querySelector("#languageSelect");select.value=arguments[0];select.dispatchEvent(new Event("change",{bubbles:true}));return true', language)
        wait_for(lambda: script('return document.documentElement.lang === arguments[0] && !document.querySelector("#languageSelect").disabled', language))
        preference = test_root / 'config/io.viento.studio/preferences.json'
        assert json.loads(preference.read_text())['language'] == language
        if language == 'en':
            assert script('return document.querySelector("#settingsTitle").textContent') == 'Settings'
            (screenshots / 'desktop-settings-en.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
        click('#settingsDialog button[type="submit"]')
        wait_for(lambda: not script('return document.querySelector("#settingsDialog").open'))

    def check_draft_language_switch():
        script('''window.languageDraftSnapshot = {
          source: document.querySelector('#docSourceEditor'),
          value: document.querySelector('#docSourceEditor').value,
          path: document.querySelector('#docCreatePathInput').value,
          type: document.querySelector('#docCreateTypeSelect').value,
          blocks: [...document.querySelectorAll('#docBlockEditor textarea')].map(node => ({node,value:node.value})),
          dirty: document.querySelector('#docEditDirtyIndicator').classList.contains('is-unsaved')
        }; return true''')
        before = {str(file.relative_to(workspace)): hashlib.sha256(file.read_bytes()).hexdigest()
                  for file in workspace.rglob('*') if file.is_file() and '.viento' not in file.relative_to(workspace).parts}
        switch_language('en')
        assert script('return document.querySelector("#modeEditBtn").textContent') == 'Edit'
        assert script('return document.querySelector("#docExportBtn").textContent') == 'Export'
        assert script('''const snapshot=window.languageDraftSnapshot;
          return snapshot.source === document.querySelector('#docSourceEditor') && snapshot.source.value === snapshot.value
            && snapshot.path === document.querySelector('#docCreatePathInput').value
            && snapshot.type === document.querySelector('#docCreateTypeSelect').value
            && snapshot.blocks.every(({node,value}) => node.isConnected && node.value === value)
            && snapshot.dirty === document.querySelector('#docEditDirtyIndicator').classList.contains('is-unsaved');''')
        click('#docExportBtn')
        assert script('return document.querySelector("#docExportStartBtn").disabled')
        assert 'Save your draft' in script('return document.querySelector("#docExportHint").textContent')
        (screenshots / 'desktop-export-en.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
        click('#docExportCloseBtn')
        (screenshots / 'desktop-editor-en.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
        after = {str(file.relative_to(workspace)): hashlib.sha256(file.read_bytes()).hexdigest()
                 for file in workspace.rglob('*') if file.is_file() and '.viento' not in file.relative_to(workspace).parts}
        assert before == after, 'Language switching changed project content'
        switch_language('zh-CN')
        assert script('return window.languageDraftSnapshot.source.value === window.languageDraftSnapshot.value')
        print('PASS: language switch preserves source / block DOM, drafts, paths and project bytes; export guard is translated', flush=True)

    def insert_files(files, event='picker'):
        encoded = [dict(name=file.name, bytes=base64.b64encode(file.read_bytes()).decode()) for file in files]
        script('''const transfer = new DataTransfer();
          for (const file of arguments[0]) transfer.items.add(new File([Uint8Array.from(atob(file.bytes), char => char.charCodeAt(0))], file.name));
          if (arguments[1] === 'picker') {
            const picker = document.querySelector('#docMediaFileInput'); picker.files=transfer.files;
            picker.dispatchEvent(new Event('change', {bubbles:true}));
          } else {
            const target = document.activeElement;
            const event = arguments[1] === 'paste' ? new ClipboardEvent('paste', {clipboardData:transfer,bubbles:true,cancelable:true}) : new DragEvent('drop', {dataTransfer:transfer,bubbles:true,cancelable:true});
            target.dispatchEvent(event);
          }
          return true;''', encoded, event)
        wait_for(lambda: script('return !document.querySelector("#docMediaDialog").open && !document.querySelector("#docSaveBtn").disabled'))

    def element(selector):
        value = command('POST', '/element', dict(using='css selector', value=selector))
        return value['element-6066-11e4-a52e-4f735466cecf']

    def click(selector):
        command('POST', f'/element/{element(selector)}/click', {})

    def select_document(title):
        encoded = json.dumps(title)
        script(f'const input=document.querySelector("#searchInput");input.value={encoded};input.dispatchEvent(new Event("input", {{bubbles:true}}));return true')
        find_button = f'[...document.querySelectorAll("button[data-path-key]")].find(button => button.title === {encoded})'
        wait_for(lambda: script(f'return !!({find_button})'))
        script(f'({find_button}).click();return true')
        wait_for(lambda: script(f'return document.querySelector("#docTitle")?.textContent.includes({encoded})'))

    def return_to_library():
        global library_returns
        # WebKit's click reply can stall when its WebView hides during the event.
        # Dispatch the actual button event after the WebDriver reply has returned.
        script('setTimeout(() => document.querySelector(".topbar-identity > button:first-child").click(), 100); return true')
        command('POST', '/window', dict(handle=main))
        library_returns += 1
        wait_for(lambda: script(f'return window.libraryReturns >= {library_returns}'))
        wait_for(lambda: script('return !document.querySelector("#activeSession").hidden'))

    def append_source(text):
        click('#docSourceEditor')
        command('POST', '/actions', {'actions': [{'type': 'key', 'id': 'keyboard', 'actions': [
            {'type': 'keyDown', 'value': '\ue009'}, {'type': 'keyDown', 'value': '\ue010'},
            {'type': 'keyUp', 'value': '\ue010'}, {'type': 'keyUp', 'value': '\ue009'},
        ]}]})
        command('POST', f'/element/{element("#docSourceEditor")}/value', dict(text=text, value=list(text)))

    def exercise_exports():
        """Optional native save-picker checks, isolated inside our Xvfb display."""
        xdotool = os.environ.get('VIENTO_TEST_XDOTOOL')
        if not xdotool:
            return
        candidates = []
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                env = dict(part.split(b'=', 1) for part in (proc / 'environ').read_bytes().split(b'\0') if b'=' in part)
                if (proc / 'comm').read_text().strip() == 'tauri-driver' and env.get(b'XDG_DATA_HOME') == str(data).encode() and b'DISPLAY' in env and b'XAUTHORITY' in env:
                    candidates.append({key.decode(): value.decode() for key, value in env.items()})
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                pass
        assert candidates, 'Isolated test display not found'
        picker_env = candidates[-1]
        # Use the data-home marker, never the user's desktop display.
        assert picker_env['XDG_DATA_HOME'] == str(data)
        def key(*args):
            window_id = subprocess.check_output([xdotool, 'search', '--onlyvisible', '--name', '保存导出文件'], env=picker_env, timeout=10).decode().splitlines()[-1]
            subprocess.run([xdotool, 'windowfocus', '--sync', window_id], env=picker_env, check=True, capture_output=True, timeout=10)
            subprocess.run([xdotool, *args], env=picker_env, check=True, capture_output=True, timeout=10)

        for kind, output_name in [('document', 'document-export.zip'), ('workspace', 'project-export.viento.zip')]:
            click('#docExportBtn')
            wait_for(lambda: script('return document.querySelector("#docExportDialog").open'))
            script('const radio=document.querySelector(`input[name="exportKind"][value="${arguments[0]}"]`);radio.checked=true;radio.dispatchEvent(new Event("change",{bubbles:true}));return true', kind)
            assert not script('return document.querySelector("#docExportStartBtn").disabled')
            (screenshots / f'desktop-export-{kind}.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
            click('#docExportStartBtn')
            wait_for(lambda: script('return document.querySelector("#docExportCloseBtn").disabled'))
            # The GTK chooser is a native window, outside the WebDriver surface.
            wait_for(lambda: subprocess.run([xdotool, 'search', '--onlyvisible', '--name', '保存导出文件'], env=picker_env, capture_output=True).returncode == 0)
            if kind == 'document':
                key('key', 'Escape')
                wait_for(lambda: script('return document.querySelector("#docExportMessage").textContent.includes("已取消保存")'))
                assert not script('return document.querySelector("#docExportSaveBtn").hidden')
                click('#docExportSaveBtn')
                wait_for(lambda: subprocess.run([xdotool, 'search', '--onlyvisible', '--name', '保存导出文件'], env=picker_env, capture_output=True).returncode == 0)
            output = test_root / output_name
            key('key', 'ctrl+l')
            key('key', 'ctrl+a')
            key('type', '--clearmodifiers', '--delay', '1', str(output))
            key('key', 'Return')
            wait_for(lambda: output.exists())
            wait_for(lambda: script('return document.querySelector("#docExportMessage").textContent.startsWith("已保存到 ")'))
            with zipfile.ZipFile(output) as archive:
                assert archive.testzip() is None
                descriptor = json.loads(archive.read('manifest.json'))
                for file in descriptor['files']:
                    content = archive.read(file['path'])
                    assert len(content) == file['size']
                    assert hashlib.sha256(content).hexdigest() == file['sha256']
                if kind == 'document':
                    html = archive.read('index.html').decode()
                    assert '旅人' in html and '<video controls' in html and '<img ' in html
                else:
                    assert descriptor['format'] == 'viento-archive'
                    restored = subprocess.run([generic_tool, 'import', str(output), str(test_root)], capture_output=True, text=True, check=True, timeout=30)
                    restored_root = Path(json.loads(restored.stdout)['root'])
                    assert json.loads((restored_root / 'workspace.json').read_text()) == manifest
                    for folder in ['documents', 'templates', 'metadata', 'assets']:
                        expected = {str(file.relative_to(workspace)): file.read_bytes() for file in (workspace / folder).rglob('*') if file.is_file()}
                        actual = {str(file.relative_to(restored_root)): file.read_bytes() for file in (restored_root / folder).rglob('*') if file.is_file()}
                        assert actual == expected, folder
                    shutil.rmtree(restored_root)
            click('#docExportCloseBtn')
        wait_for(lambda: not list((private / 'cache/exports').iterdir()))
        print('PASS: native export dialog → cancel / retry GTK save picker → offline document with media → complete project export → native import with exact source and asset bytes → staging cleanup', flush=True)

    try:
        wait_for(lambda: request('GET', '/status'))
        capabilities = dict(browserName='wry', unhandledPromptBehavior='ignore', **{'tauri:options': {'application': str(application)}})
        session = request('POST', '/session', {'capabilities': {'alwaysMatch': capabilities}})['sessionId']
        wait_for(lambda: script('return document.querySelectorAll(".workspace").length === 1'))
        if os.environ.get('VIENTO_EXPECT_APP_VERSION'):
            script('window.testVersion=null; window.__TAURI__.core.invoke("library_state").then(value => window.testVersion=value); return true')
            release = wait_for(lambda: script('return window.testVersion'))
            expected = os.environ['VIENTO_EXPECT_APP_VERSION']
            assert release['version'] == expected, release
            assert script('return document.querySelector("#appVersion").textContent') == expected
            assert expected in script('return document.title')
            if os.environ.get('VIENTO_EXPECT_BUILD_VERSION'):
                assert release['buildVersion'] == os.environ['VIENTO_EXPECT_BUILD_VERSION'], release
        if os.environ.get('VIENTO_TEST_LANGUAGE'):
            switch_language('en')
            assert script('return document.querySelector("#createBtn").textContent') == 'New library'
            # Restart the real application with the same isolated config directory.
            request('DELETE', f'/session/{session}')
            session = None
            session = request('POST', '/session', {'capabilities': {'alwaysMatch': capabilities}})['sessionId']
            wait_for(lambda: script('return document.querySelectorAll(".workspace").length === 1'))
            assert script('return document.documentElement.lang') == 'en'
            assert script('return document.querySelector("#settingsBtn").textContent') == 'Settings'
            (screenshots / 'desktop-library-en.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
            switch_language('zh-CN')
            print('PASS: settings language survives a full native application restart', flush=True)
        main = command('GET', '/window')
        script('window.libraryReturns=0; window.__TAURI__.event.listen("library-changed", () => window.libraryReturns++).then(() => window.libraryListenerReady=true); return true')
        wait_for(lambda: script('return window.libraryListenerReady === true'))
        screenshot = command('GET', '/screenshot')
        (screenshots / 'desktop-library.png').write_bytes(base64.b64decode(screenshot))
        if generic_tool:
            click('#createBtn')
            assert '通用 OC 项目' in script('return document.querySelector("#createDialog").textContent')
            click('#cancelCreateBtn')
        if os.environ.get('VIENTO_TEST_LANGUAGE'):
            switch_language('en')
        click('.workspace-actions .open')
        if os.environ.get('VIENTO_EXPECT_OLD_VERSION_REJECTION') == '1':
            wait_for(lambda: script('return document.querySelector("#status")?.classList.contains("error")'))
            message = script('return document.querySelector("#status").textContent')
            assert '兼容' in message or '版本' in message or '格式不受支持' in message, message
            assert len(command('GET', '/window/handles')) == 1
            assert source.read_bytes() == original.encode()
            assert json.loads((workspace / 'workspace.json').read_text()) == manifest
            print('PASS: actual v0.1 app rejects v2 guard before opening editor; original data preserved')
            sys.exit(0)
        handles = wait_for(lambda: (h if len(h) == 2 else False) if (h := command('GET', '/window/handles')) else False)
        editor = next(handle for handle in handles if handle != main)
        command('POST', '/window', dict(handle=editor))
        if os.environ.get('VIENTO_TEST_LANGUAGE'):
            wait_for(lambda: script('return document.documentElement.lang === "en" && document.querySelector("#settingsDialog")'))
            switch_language('zh-CN')
            print('PASS: a new editor origin loads the language saved by the library', flush=True)
        if generic_tool:
            wait_for(lambda: script('return !!document.querySelector("#docCreateBtn")?.offsetParent && !document.querySelector("#docCreateBtn").disabled'))
            command('POST', '/window/rect', dict(width=1280, height=900))
            assert json.loads((private / 'cache/indexes/documents.json').read_text())['count'] == 0
            assert script('return [...document.querySelectorAll("#categoryTabs button")].map(node => node.textContent)') == ['全部（0）', '档案（0）', '角色（0）', '故事（0）', '地点（0）', '组织（0）', '设定（0）', '种族（0）']
            click('#docCreateBtn')
            wait_for(lambda: script('return document.querySelector("#workspaceShell").classList.contains("is-creating") && !document.querySelector("#docSourceEditor").disabled'))
            options = script('return [...document.querySelector("#docCreateTypeSelect").options].map(option => [option.value,option.textContent])')
            assert options == [['document', '档案'], ['character', '角色'], ['story', '故事'], ['place', '地点'], ['organization', '组织'], ['concept', '设定'], ['species', '种族']], options
            script('const select=document.querySelector("#docCreateTypeSelect");select.value="character";select.dispatchEvent(new Event("change",{bubbles:true}));return true')
            wait_for(lambda: script('return document.querySelector("#docSourceEditor").value.includes("## 背景与经历") && !document.querySelector("#docSaveBtn").disabled'))
            assert script(r'return /^documents\/characters\/.+\.md$/.test(document.querySelector("#docCreatePathInput").value)')
            assert '力量' not in script('return document.querySelector("#docSourceEditor").value')
            if os.environ.get('VIENTO_TEST_XDOTOOL'):
                pending_source = script('return document.querySelector("#docSourceEditor").value')
                click('#docExportBtn')
                assert script('return document.querySelector("#docExportStartBtn").disabled')
                assert '先保存' in script('return document.querySelector("#docExportHint").textContent')
                click('#docExportCloseBtn')
                assert script('return document.querySelector("#docSourceEditor").value') == pending_source
            (screenshots / 'desktop-generic-create.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
            character_source = workspace / 'documents/characters/旅人.md'
            script('const path=document.querySelector("#docCreatePathInput");path.value="documents/characters/旅人.md";path.dispatchEvent(new Event("input",{bubbles:true}));const e=document.querySelector("#docSourceEditor");e.value="# 旅人\\n\\n身份：旅人\\n\\n## 背景与经历\\n属于角色自己的背景。\\n\\n";e.dispatchEvent(new Event("input",{bubbles:true}));e.focus();e.setSelectionRange(e.value.length,e.value.length);return true')
            insert_files([imported_image, imported_webm, imported_mp4])
            assert not character_source.exists()
            wait_for(lambda: script('return document.querySelector("#docMediaPreview img")?.naturalWidth === 320 && [...document.querySelectorAll("#docMediaPreview video")].filter(v => v.readyState >= 1).length === 2'))
            click('#docSaveBtn')
            wait_for(lambda: script('return !document.querySelector("#workspaceShell").classList.contains("is-creating") && !document.querySelector("#docSaveBtn").disabled && !document.querySelector("#docEditDirtyIndicator").classList.contains("is-unsaved")'))
            assert '属于角色自己的背景。' in character_source.read_text()
            assert len(list((workspace / 'metadata/documents').glob('*.json'))) == 1
            index = json.loads((private / 'cache/indexes/documents.json').read_text())
            assert index['docs'][0]['category'] == 'character'
            assert len(index['docs'][0]['assetRefs']) == 3
            click('#docEditBtn')
            wait_for(lambda: script('return !document.querySelector("#workspaceShell").classList.contains("is-writing")'))
            # Exercise the real project settings UI before creating the next
            # document. Existing source bytes and identities must stay intact.
            saved_character = character_source.read_bytes()
            saved_descriptors = {file.name: file.read_bytes() for file in (workspace / 'metadata/documents').glob('*.json')}
            click('#projectSettingsBtn')
            wait_for(lambda: script('return document.querySelector("#projectSettingsDialog").open && document.querySelector("#projectTypeList").options.length === 7 && !document.querySelector("#projectTypeFields").disabled'))
            script('const select=document.querySelector("#projectTypeList");select.value="species";select.dispatchEvent(new Event("change",{bubbles:true}));return true')
            assert script('return document.querySelector("#projectTypeId").readOnly')
            script('const e=document.querySelector("#projectTemplateContent");e.value+="存在: false\\n备注: null\\n";e.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#projectTypeFields details").open=true;document.querySelector("#projectTitleField").value="title";return true')
            click('#projectGroupAdd')
            script('const row=document.querySelector("#projectFieldGroups").firstElementChild;row.querySelector("input").value="生命特征";row.querySelector("textarea").value="灵魂数量\\n存在";row.querySelector("textarea").dispatchEvent(new Event("input",{bubbles:true}));return true')
            click('#projectTemplatePreview')
            wait_for(lambda: script('return !document.querySelector("#projectTemplatePreviewPanel").hidden && !document.querySelector("#projectTypeFields").disabled'))
            assert script('return document.querySelector("#projectTemplatePreviewContent").textContent.includes("false") && document.querySelector("#projectTemplatePreviewContent").textContent.includes("null")')
            (screenshots / 'desktop-project-template-preview.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
            click('#projectTemplateSave')
            wait_for(lambda: script('return document.querySelector("#projectSettingsMessage").textContent.includes("已保存") && !document.querySelector("#projectTypeFields").disabled'))
            assert character_source.read_bytes() == saved_character
            assert {file.name: file.read_bytes() for file in (workspace / 'metadata/documents').glob('*.json')} == saved_descriptors
            click('#projectTypeAdd')
            script('for(const [id,value] of Object.entries({projectTypeId:"event",projectTypeLabel:"事件",projectTypeDirectory:"events",projectTemplateContent:"# 新建事件\\n\\n时间：\\n地点：\\n"})){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event("input",{bubbles:true}));}return true')
            click('#projectTemplateSave')
            wait_for(lambda: script('return document.querySelector("#projectTypeList").options.length === 8 && !document.querySelector("#projectTypeFields").disabled'))
            click('#projectSettingsClose')
            wait_for(lambda: script('return !document.querySelector("#projectSettingsDialog").open && [...document.querySelectorAll("#categoryTabs button")].some(button=>button.textContent.startsWith("事件"))'))
            manifest = json.loads((workspace / 'workspace.json').read_text())
            assert manifest['documentTypes'][-1]['id'] == 'event'
            print('PASS: project template editor → typed preview → live save → add a type → unchanged authored content / metadata', flush=True)
            click('#docCreateBtn')
            wait_for(lambda: script('return document.querySelector("#workspaceShell").classList.contains("is-creating") && !document.querySelector("#docSourceEditor").disabled'))
            script('const select=document.querySelector("#docCreateTypeSelect");select.value="species";select.dispatchEvent(new Event("change",{bubbles:true}));return true')
            wait_for(lambda: script('return document.querySelector("#docSourceEditor").value.includes("由项目自己的模板定义") && !document.querySelector("#docSaveBtn").disabled'))
            assert script(r'return /^documents\/species\/.+\.yaml$/.test(document.querySelector("#docCreatePathInput").value)')
            species_source = workspace / 'documents/自定义目录/星裔.yaml'
            script('const path=document.querySelector("#docCreatePathInput");path.value="documents/自定义目录/星裔.yaml";path.dispatchEvent(new Event("input",{bubbles:true}));const e=document.querySelector("#docSourceEditor");e.value=e.value.replace("新建种族","星裔");e.dispatchEvent(new Event("input",{bubbles:true}));return true')
            species_draft = script('return document.querySelector("#docSourceEditor").value')
            if os.environ.get('VIENTO_TEST_LANGUAGE'):
                check_draft_language_switch()
                assert script('return [...document.querySelector("#docCreateTypeSelect").options].some(option => option.textContent === "种族")')
            click('#docSaveBtn')
            wait_for(lambda: script('return !document.querySelector("#workspaceShell").classList.contains("is-creating") && !document.querySelector("#docSaveBtn").disabled && !document.querySelector("#docEditDirtyIndicator").classList.contains("is-unsaved")'))
            assert species_source.read_text() == species_draft
            click('#docEditBtn')
            wait_for(lambda: script('return !document.querySelector("#workspaceShell").classList.contains("is-writing")'))
            index = json.loads((private / 'cache/indexes/documents.json').read_text())
            assert index['count'] == 2
            species_record = next(doc for doc in index['docs'] if doc['source']['path'].endswith('星裔.yaml'))
            assert species_record['category'] == 'species', species_record
            script('[...document.querySelectorAll("#categoryTabs button")].find(node => node.textContent.startsWith("种族")).click();return true')
            wait_for(lambda: script('return document.querySelectorAll("#docList button[data-path-key]").length === 1'))
            assert script('return document.querySelector("#docList button[data-path-key]").title') == '星裔'
            assert script('return [...document.querySelectorAll(".document-field-label")].find(node => node.textContent === "灵魂数量").nextElementSibling.textContent') == '2'
            (screenshots / 'desktop-generic-species.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
            script('[...document.querySelectorAll("#categoryTabs button")].find(node => node.textContent.startsWith("全部")).click();return true')
            select_document('旅人')
            wait_for(lambda: script('return document.querySelectorAll(".document-section video").length === 2 && document.querySelector(".document-section img")?.naturalWidth === 320'))
            exercise_exports()
            return_to_library()
            click('#closeEditorBtn')
            wait_for(lambda: len(command('GET', '/window/handles')) == 1)
            command('POST', '/window', dict(handle=main))
            # The actual desktop backup functions must retain all source,
            # type, template, metadata and media bytes at a different root.
            archive = test_root / 'generic-project.viento.zip'
            subprocess.run([generic_tool, 'export', str(workspace), str(archive)], capture_output=True, check=True, timeout=30)
            restored = subprocess.run([generic_tool, 'import', str(archive), str(test_root)], capture_output=True, text=True, check=True, timeout=30)
            restored_root = Path(json.loads(restored.stdout)['root'])
            assert restored_root != workspace
            assert json.loads((restored_root / 'workspace.json').read_text()) == manifest
            for data_root in ['documents', 'templates', 'metadata', 'assets']:
                expected = {str(file.relative_to(workspace)): file.read_bytes() for file in (workspace / data_root).rglob('*') if file.is_file()}
                actual = {str(file.relative_to(restored_root)): file.read_bytes() for file in (restored_root / data_root).rglob('*') if file.is_file()}
                assert actual == expected, data_root
            assert not (restored_root / '.viento/cache').exists()
            print('PASS: native v3 creation → empty generic project → project-owned types → character background + PNG / WebM / MP4 → custom YAML template + chosen folder + saved type → reopen → full backup and byte-identical restore', flush=True)
            sys.exit(0)
        wait_for(lambda: script('return !!document.querySelector("#docEditBtn") && !document.querySelector("#docEditBtn").disabled'))
        select_document('原生桌面测试')
        wait_for(lambda: script('return document.querySelector("#docTitle")?.textContent.includes("原生桌面测试")'))
        if os.environ.get('VIENTO_EXPECT_APP_VERSION'):
            assert script('return document.querySelector("#appVersion").textContent') == os.environ['VIENTO_EXPECT_APP_VERSION']
        editor_origin = script('return location.origin')
        outside = test_root / 'outside-documents'
        outside.mkdir()
        private_source = outside / 'keep.md'
        private_source.write_text('不属于作品库的内容')
        linked = workspace / 'design-data/native-link'
        linked.symlink_to(outside, target_is_directory=True)
        try:
            script('''window.callPathResult=null; (async () => {
              const json = (body) => ({method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
              const statuses = await Promise.all([
                fetch(location.origin + '//['),
                fetch('/api/rebuild', json({source:'../outside.md'})),
                fetch('/api/doc?path=design-data/native-link/keep.md'),
                fetch('/api/doc', json({path:'design-data/native-link/keep.md', content:'不得改写库外', force:true})),
                fetch('/design-data/native-link/keep.md')
              ].map(async (request) => { const response=await request; await response.arrayBuffer(); return response.status; }));
              const health=await fetch('/api/health');
              window.callPathResult={statuses, health:health.status};
            })().catch(error => window.callPathResult={error:String(error)}); return true''')
            result = wait_for(lambda: script('return window.callPathResult'))
            assert result == dict(statuses=[400, 400, 403, 403, 403], health=200), result
            assert private_source.read_text() == '不属于作品库的内容'
        finally:
            linked.unlink()
        script('''window.mediaResult=null; import('/web/modules/app-helpers.js').then(({resolveImageUrl}) => {
          const image=new Image(); image.onload=async () => {
            const response=await fetch(image.src, {headers:{Range:'bytes=0-3'}});
            window.mediaResult={width:image.naturalWidth, url:image.src, status:response.status, prefix:await response.text()};
          }; image.onerror=() => window.mediaResult={error:true}; image.src=resolveImageUrl('assets/concept/图#1.svg');
        }); return true''')
        media = wait_for(lambda: script('return window.mediaResult'))
        assert media.get('width') == 2 and media.get('status') == 206 and media.get('prefix') == '<svg', media
        assert '%231.svg' in media['url'], media
        script('window.nativeAccess="pending"; window.__TAURI__.core.invoke("library_state").then(() => window.nativeAccess="allowed", () => window.nativeAccess="denied"); return true')
        wait_for(lambda: script('return window.nativeAccess === "denied"'))
        select_document('邪魔匕首')
        metric_rows = script('return [...document.querySelectorAll(".document-value-rows .document-field")].map(row => [row.querySelector(".document-field-label").textContent,row.querySelector(".document-field-value").textContent])')
        assert metric_rows == [['技能伤害', '+15%'], ['魔法上限', '+350'], ['移动速度', '+20']], metric_rows
        assert script('return [...document.querySelectorAll(".document-field-label")].find(node => node.textContent === "价格").nextElementSibling.textContent') == '4000'
        assert script('return document.querySelectorAll(".metric-item-meter").length') == 0
        script('document.querySelector(".document-section").scrollIntoView({block:"center"});return true')
        screenshot = command('GET', '/screenshot')
        (screenshots / 'desktop-item-attributes.png').write_bytes(base64.b64decode(screenshot))
        # A narrow card must retain separate values instead of overflowing.
        script('document.querySelector(".document-section").style.maxWidth="220px";return true')
        assert script('const card=document.querySelector(".document-section");const bounds=card.getBoundingClientRect();return [...card.querySelectorAll(".document-field-label,.document-field-value")].every(node => {const r=node.getBoundingClientRect();return r.left>=bounds.left && r.right<=bounds.right+1 && node.scrollWidth<=node.clientWidth+1})')
        assert item_source.read_text() == item_original
        select_document('测试角色')
        assert script('return [...document.querySelectorAll("#docList button[data-path-key]")].map(button => button.title)') == ['测试角色']
        assert script('return [...document.querySelectorAll(".document-field-label")].find(node => node.textContent === "灵魂数量").nextElementSibling.textContent') == '0'
        screenshot = command('GET', '/screenshot')
        (screenshots / 'desktop-oc-character.png').write_bytes(base64.b64decode(screenshot))
        script('document.querySelectorAll(".document-navigation button")[1].click();return true')
        wait_for(lambda: script('return document.querySelector("#docTitle").textContent === "测试角色经历"'))
        assert script('return document.querySelector(".document-navigation").textContent.includes("返回 测试角色")')
        assert script('return document.querySelector("#docList .doc-owned-item.is-active").title') == '测试角色经历'
        assert script('return document.querySelector("#docList .doc-owned-list .doc-owned-list .doc-owned-item").title') == '童年片段'
        click('.document-navigation button[title="童年片段"]')
        wait_for(lambda: script('return document.querySelector("#docTitle").textContent === "童年片段"'))
        click('.document-navigation button[title="返回 测试角色经历"]')
        wait_for(lambda: script('return document.querySelector("#docTitle").textContent === "测试角色经历"'))
        click('#docEditBtn')
        wait_for(lambda: script('return document.querySelector("#workspaceShell").classList.contains("is-writing")'))
        append_source('\n角色背景编辑验证。')
        click('#docSaveBtn')
        wait_for(lambda: script('return !document.querySelector("#docSaveBtn").disabled && !document.querySelector("#docEditDirtyIndicator").classList.contains("is-unsaved")'))
        assert '角色背景编辑验证。' in biography_source.read_text()
        assert character_source.read_text() == character_original
        assert script('return document.querySelector("#docTitle").textContent') == '测试角色经历'
        click('#docEditBtn')
        wait_for(lambda: script('return !document.querySelector("#workspaceShell").classList.contains("is-writing")'))
        script('const input=document.querySelector("#searchInput");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));return true')
        wait_for(lambda: script('return document.querySelectorAll("#docList button[data-path-key]").length === 3'))
        script('const input=document.querySelector("#searchInput");input.value="只在背景中的暗号";input.dispatchEvent(new Event("input",{bubbles:true}));return true')
        wait_for(lambda: script('return document.querySelectorAll("#docList button[data-path-key]").length === 1'))
        assert script('return document.querySelector("#docList button[data-path-key]").title') == '测试角色'
        script('[...document.querySelectorAll(".document-navigation button")].find(button => button.textContent.includes("返回 测试角色")).click();return true')
        wait_for(lambda: script('return document.querySelector("#docTitle").textContent === "测试角色"'))
        screenshot = command('GET', '/screenshot')
        (screenshots / 'desktop-oc-ownership.png').write_bytes(base64.b64decode(screenshot))
        # Exercise the actual editor events, uploads, draft preview and media
        # decoders. Source edits remain unsaved until the user clicks Save.
        command('POST', '/window/rect', dict(width=1280, height=900))
        click('#docEditBtn')
        wait_for(lambda: script('return document.querySelector("#workspaceShell").classList.contains("is-writing")'))
        script('const e=document.querySelector("#docSourceEditor");e.focus();e.setSelectionRange(e.value.length,e.value.length);return true')
        click('#docMediaInsertBtn')
        wait_for(lambda: script('return document.querySelector("#docMediaList .doc-media-choice") !== null'))
        insert_files([imported_image, imported_webm, imported_mp4])
        assert character_source.read_text() == character_original
        assert script('return document.querySelector("#docSourceEditor").value.includes("!video[动作预览.mp4](asset:")')
        wait_for(lambda: script('return document.querySelector("#docMediaPreview img")?.naturalWidth === 320'))
        for index in range(2):
            wait_for(lambda: script('const v=document.querySelectorAll("#docMediaPreview video")[arguments[0]];return v?.readyState >= 1 && v.duration > 2', index))
            assert script('const v=document.querySelectorAll("#docMediaPreview video")[arguments[0]];return v.paused && !v.autoplay && v.controls', index)
            script('const v=document.querySelectorAll("#docMediaPreview video")[arguments[0]];v.play().catch(error => window.playbackError=String(error));return true', index)
            wait_for(lambda: script('return document.querySelectorAll("#docMediaPreview video")[arguments[0]].currentTime > .2', index))
            script('const v=document.querySelectorAll("#docMediaPreview video")[arguments[0]];v.pause();v.currentTime=1.5;return true', index)
            wait_for(lambda: script('const v=document.querySelectorAll("#docMediaPreview video")[arguments[0]];return !v.seeking && v.currentTime >= 1.4', index))
        def media_fits():
            return script('''const source=document.querySelector('#docSourceEditor').getBoundingClientRect();
              const preview=document.querySelector('#docMediaPreview'), bounds=preview.getBoundingClientRect();
              return source.width > 300 && source.height > 180 && preview.clientWidth >= preview.scrollWidth-1 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;''')
        assert media_fits()
        (screenshots / 'desktop-media-editor.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
        command('POST', '/window/rect', dict(width=900, height=800))
        assert media_fits()
        command('POST', '/window/rect', dict(width=1280, height=900))
        # Existing selection, paste and drop reuse exactly the same imported
        # asset; switching source/block modes must not damage their references.
        assets_before = len(list((workspace / 'metadata/assets').glob('*.json')))
        assert assets_before == 4
        script('const e=document.querySelector("#docSourceEditor");e.focus();e.setSelectionRange(e.value.length,e.value.length);return true')
        click('#docMediaInsertBtn')
        wait_for(lambda: script('return [...document.querySelectorAll(".doc-media-choice")].some(button => button.title === "角色参考 #1.png")'))
        script('[...document.querySelectorAll(".doc-media-choice")].find(button => button.title === "角色参考 #1.png").click();return true')
        wait_for(lambda: script('return !document.querySelector("#docMediaDialog").open'))
        click('#docEditBlockModeBtn')
        script('const e=[...document.querySelectorAll("#docBlockEditor textarea")].at(-1);e.focus();e.setSelectionRange(e.value.length,e.value.length);return true')
        insert_files([imported_image], 'paste')
        insert_files([imported_image], 'drop')
        assert len(list((workspace / 'metadata/assets').glob('*.json'))) == assets_before
        click('#docEditSourceModeBtn')
        media_draft = script('return document.querySelector("#docSourceEditor").value')
        assert media_draft.count('![角色参考 #1.png](asset:') == 4, media_draft
        assert media_draft.count('!video[') == 2
        click('#docSaveBtn')
        wait_for(lambda: script('return !document.querySelector("#docSaveBtn").disabled && !document.querySelector("#docEditDirtyIndicator").classList.contains("is-unsaved")'))
        assert character_source.read_text() == media_draft
        click('#docEditBtn')
        wait_for(lambda: script('return !document.querySelector("#workspaceShell").classList.contains("is-writing")'))
        select_document('原生桌面测试')
        select_document('测试角色')
        wait_for(lambda: script('return document.querySelectorAll(".document-section video").length === 2 && [...document.querySelectorAll(".document-section img")].filter(img => img.naturalWidth === 320).length === 4'))
        assert script('return [...document.querySelectorAll(".document-section video")].every(video => video.paused && video.controls)')
        script('document.querySelector(".document-section video").scrollIntoView({block:"center"});return true')
        (screenshots / 'desktop-media-saved.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
        document_index = json.loads((private / 'cache/indexes/documents.json').read_text())
        character_record = next(doc for doc in document_index['docs'] if doc['id'] == character_id)
        assert len(character_record['assetRefs']) == 3, character_record['assetRefs']
        print('PASS: media picker → PNG / WebM / MP4 import → unsaved draft preview → native playback + seeking → responsive editor → reuse + paste + block drop → stable IDs → save → reopen + inline media', flush=True)
        select_document('原生桌面测试')
        click('#docEditBtn')
        wait_for(lambda: script('return document.querySelector("#workspaceShell").classList.contains("is-writing")'))
        append_source('\n原生窗口保存验证。')
        wait_for(lambda: script('return document.querySelector("#docEditDirtyIndicator").classList.contains("is-unsaved")'))
        click('#docEditBlockModeBtn')
        wait_for(lambda: script('return !document.querySelector("#docBlockEditor").classList.contains("is-hidden")'))
        if os.environ.get('VIENTO_TEST_LANGUAGE'):
            check_draft_language_switch()
        click('#docEditSourceModeBtn')
        wait_for(lambda: script('return !document.querySelector("#docSourceEditor").disabled'))
        click('#docSaveBtn')
        wait_for(lambda: script('return !document.querySelector("#docSaveBtn").disabled && !document.querySelector("#docEditDirtyIndicator").classList.contains("is-unsaved")'))
        saved = source.read_bytes()
        assert saved.startswith(original.encode())
        assert '原生窗口保存验证。'.encode() in saved
        assert b'\r\n' in saved
        screenshot = command('GET', '/screenshot')
        (screenshots / 'desktop-editor.png').write_bytes(base64.b64decode(screenshot))
        append_source('\n未保存草稿保留测试。')
        click('#docEditBtn')
        wait_for(lambda: command('GET', '/alert/text'))
        command('POST', '/alert/dismiss', {})
        assert script('return document.querySelector("#workspaceShell").classList.contains("is-writing")')
        assert script('return document.querySelector("#docSourceEditor").value.includes("未保存草稿保留测试")')
        if os.environ.get('VIENTO_TEST_LANGUAGE'):
            switch_language('en')
        return_to_library()
        if os.environ.get('VIENTO_TEST_LANGUAGE'):
            assert script('return document.querySelector("#resumeBtn").textContent') == 'Resume editing'
            switch_language('zh-CN')
            command('POST', '/window', dict(handle=editor))
            wait_for(lambda: script('return document.documentElement.lang === "zh-CN"'))
            assert script('return document.querySelector("#docSourceEditor").value.includes("未保存草稿保留测试")')
            command('POST', '/window', dict(handle=main))
            print('PASS: language synchronizes between library and editor without losing the active draft', flush=True)
        click('#closeEditorBtn')
        command('POST', '/window', dict(handle=editor))
        text = wait_for(lambda: command('GET', '/alert/text'))
        assert '未保存' in text
        command('POST', '/alert/dismiss', {})
        wait_for(lambda: script('return document.querySelector("#docSourceEditor").value.includes("未保存草稿保留测试")'))
        return_to_library()
        wait_for(lambda: script('return !document.querySelector("#closeEditorBtn").disabled'))
        click('#closeEditorBtn')
        command('POST', '/window', dict(handle=editor))
        wait_for(lambda: command('GET', '/alert/text'))
        command('POST', '/alert/accept', {})
        wait_for(lambda: len(command('GET', '/window/handles')) == 1)
        command('POST', '/window', dict(handle=main))
        assert '未保存草稿保留测试'.encode() not in source.read_bytes()
        assert (private / 'cache/indexes/documents.json').is_file()
        assert (private / 'cache/indexes/assets.json').is_file()
        assert (private / 'cache/indexes/references.json').is_file()
        assert len(list((workspace / 'metadata/documents').glob('*.json'))) == 5
        assert not (workspace / 'web').exists()

        def engine_stopped():
            try:
                urllib.request.urlopen(editor_origin + '/api/health', timeout=1)
            except urllib.error.URLError as error:
                return not isinstance(error, urllib.error.HTTPError)
            return False

        wait_for(engine_stopped)
        print('PASS: native library → authenticated editor → request recovery + link isolation → encoded SVG + range request → native access denied → universal fields + separate attributes + narrow card → character-owned background → edit background + save + search + return → edit → block/source conversion → save → cancel discard → library → cancel close → discard confirmed → engine shutdown')
    except Exception:
        if session:
            try:
                print('Native page at failure:', script('return document.body.innerText').__str__()[:2500], flush=True)
                print('Editor at failure:', script('const e=document.querySelector("#docSourceEditor");return e ? {value:e.value, disabled:e.disabled, readOnly:e.readOnly, focus:document.activeElement.id} : null'), flush=True)
            except Exception:
                pass
        raise
    finally:
        if session:
            try:
                request('DELETE', f'/session/{session}')
            except Exception:
                pass
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        log.close()
