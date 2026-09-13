"""Shared native regression for leaving type/template drafts without writing them."""
import base64


def exercise_project_settings_navigation(*, script, click, command, wait_for, workspace, screenshots):
    before = {str(file.relative_to(workspace)): file.read_bytes()
              for file in workspace.rglob('*') if file.is_file() and '.viento' not in file.relative_to(workspace).parts}
    previous = script('return document.querySelector("#projectTypeList").value')
    assert previous
    original = script('return document.querySelector("#projectTemplateContent").value')

    def escape():
        command('POST', '/actions', {'actions': [{'type': 'key', 'id': 'keyboard', 'actions': [
            {'type': 'keyDown', 'value': '\ue00c'}, {'type': 'keyUp', 'value': '\ue00c'},
        ]}]})

    def confirm(accept):
        assert '未保存' in wait_for(lambda: command('GET', '/alert/text'))
        command('POST', '/alert/accept' if accept else '/alert/dismiss', {})

    def unchanged_selection():
        assert script('return document.querySelector("#projectSettingsDialog").open')
        assert script('return document.querySelector("#projectTypeList").value') == previous
        assert script('return document.querySelector("#projectTemplateContent").value') == original
        assert script('return document.querySelector("#projectSettingsDialog").dataset.dirty') == 'false'
        assert script('return document.querySelector("#projectTypeCancel").hidden')

    for leave in [lambda: click('#projectTypeCancel'), escape]:
        click('#projectTypeAdd')
        assert script('return document.querySelector("#projectTypeCancel").textContent') == '取消新增'
        assert script('return !document.querySelector("#projectTypeCancel").hidden && document.querySelector("#projectTypeAdd").disabled')
        leave()
        unchanged_selection()

    click('#projectTypeAdd')
    script(r'''for (const [id, value] of Object.entries({projectTypeId: 'cancelled_type', projectTypeLabel: '未保存的类型', projectTypeDirectory: 'cancelled', projectTemplateContent: '# 必须保留的草稿\n\n正文。\n'})) {
      const node=document.getElementById(id); node.value=value; node.dispatchEvent(new Event('input', {bubbles:true}));
    } return true''')
    draft = script('return [...document.querySelectorAll("#projectTypeForm input, #projectTypeForm textarea, #projectTypeForm select")].map(node=>node.value)')

    # Translation must update navigation labels without rebuilding the draft.
    script('import("/web/i18n/index.js").then(module=>module.applyLanguage("en")); return true')
    wait_for(lambda: script('return document.documentElement.lang === "en"'))
    assert script('return document.querySelector("#projectTypeCancel").textContent') == 'Cancel new type'
    assert script('return document.querySelector("#projectSettingsClose").textContent') == 'Back to editor'
    assert script('return [...document.querySelectorAll("#projectTypeForm input, #projectTypeForm textarea, #projectTypeForm select")].map(node=>node.value)') == draft
    script('import("/web/i18n/index.js").then(module=>module.applyLanguage("zh-CN")); return true')
    wait_for(lambda: script('return document.documentElement.lang === "zh-CN"'))

    for width, height, name in [(1280, 900, 'desktop-type-cancel'), (760, 600, 'desktop-type-cancel-narrow')]:
        command('POST', '/window/rect', dict(width=width, height=height))
        script('const body=document.querySelector(".project-settings-body"); body.scrollTop=body.scrollHeight; return true')
        assert script('''return ['projectTypeCancel','projectSettingsClose','projectTemplatePreview','projectTemplateSave'].every(id=>{
          const node=document.getElementById(id), rect=node.getBoundingClientRect();
          return !node.hidden && rect.width>0 && rect.left>=0 && rect.top>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight;
        })'''), 'Navigation buttons must remain visible while the form scrolls'
        (screenshots / f'{name}.png').write_bytes(base64.b64decode(command('GET', '/screenshot')))
    command('POST', '/window/rect', dict(width=1280, height=900))

    for leave in [lambda: click('#projectTypeCancel'), escape, lambda: click('#projectSettingsClose'),
                  lambda: script('const node=document.querySelector("#projectTypeList");node.value=arguments[0];node.dispatchEvent(new Event("change",{bubbles:true}));return true', previous)]:
        leave()
        confirm(False)
        assert script('return document.querySelector("#projectSettingsDialog").open && document.querySelector("#projectSettingsDialog").dataset.dirty === "true"')
        assert script('return document.querySelector("#projectTypeList").value') == ''
        assert script('return [...document.querySelectorAll("#projectTypeForm input, #projectTypeForm textarea, #projectTypeForm select")].map(node=>node.value)') == draft

    click('#projectTypeCancel')
    confirm(True)
    unchanged_selection()

    # Existing types restore the last saved content and keep their identity.
    script(r'const node=document.querySelector("#projectTemplateContent");node.value+="\n未保存的模板修改";node.dispatchEvent(new Event("input",{bubbles:true}));return true')
    assert script('return document.querySelector("#projectTypeCancel").textContent') == '放弃修改'
    click('#projectTypeCancel')
    confirm(True)
    unchanged_selection()

    # Returning to the editor also discards only after confirmation, and reopen
    # must not resurrect the abandoned new type.
    click('#projectTypeAdd')
    script('const node=document.querySelector("#projectTypeLabel");node.value="不应写入的类型";node.dispatchEvent(new Event("input",{bubbles:true}));return true')
    click('#projectSettingsClose')
    confirm(True)
    wait_for(lambda: script('return !document.querySelector("#projectSettingsDialog").open'))
    click('#projectSettingsBtn')
    wait_for(lambda: script('return document.querySelector("#projectSettingsDialog").open && !document.querySelector("#projectTypeFields").disabled'))
    script('const node=document.querySelector("#projectTypeList");node.value=arguments[0];node.dispatchEvent(new Event("change",{bubbles:true}));return true', previous)
    unchanged_selection()
    after = {str(file.relative_to(workspace)): file.read_bytes()
             for file in workspace.rglob('*') if file.is_file() and '.viento' not in file.relative_to(workspace).parts}
    assert after == before, 'Cancel/back must not write project definitions, templates, source, metadata or media'
    print('PASS: cancel new type / Escape / back / type switch → retain or discard drafts → restore selection → translated controls → narrow layout → unchanged project bytes', flush=True)
