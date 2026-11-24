" vim -Nu NONE -Es -S vim/test.vim — checks the plugin against a fake ~/.claude; exit code 1 if a check fails.
set encoding=utf-8
scriptencoding utf-8
let s:root = expand('<sfile>:p:h')
let $HOME = tempname()
let $CLAUDE_CONFIG_DIR = ''
let g:cairn_lang = 'en'
let s:c = $HOME . '/.claude'
call mkdir(s:c . '/tasks/s1', 'p')
call mkdir(s:c . '/projects/p', 'p')
call mkdir($HOME . '/project', 'p')
call writefile(['{"type":"user","cwd":"' . $HOME . '/project"}'], s:c . '/projects/p/s1.jsonl')
call writefile(['{"id":"1","subject":"Read","status":"completed"}'], s:c . '/tasks/s1/1.json')
call writefile(['{"id":"2","subject":"Code","activeForm":"Coding","status":"in_progress"}'], s:c . '/tasks/s1/2.json')
call writefile(['{"id":"3","subject":"Test","status":"pending","blockedBy":["2"]}'], s:c . '/tasks/s1/3.json')
call writefile(['{"id":"10","subject":"Review","status":"pending"}'], s:c . '/tasks/s1/10.json')

execute 'source ' . s:root . '/plugin/cairn.vim'

let s:l = CairnLines($HOME . '/project')
call assert_equal('cairn · project', s:l[0])
call assert_match('^1/4 steps · 25 %', s:l[1])
call assert_match('^✓ 1\. Read', s:l[4])
call assert_equal('▶ 2. Code', s:l[5])
call assert_match('Coding… · since', s:l[6])
call assert_equal('○ 3. Test  (after #2)', s:l[7])
call assert_equal('○ 10. Review', s:l[8])
call assert_match('Nothing to mark yet', join(CairnLines('/elsewhere')))

" Claude is waiting: shown as long as the transcript has not moved since
call mkdir(s:c . '/cairn/state', 'p')
call writefile(['{"waiting": true, "message": "Bash permission", "t": ' . (localtime() + 60) . '}'], s:c . '/cairn/state/s1.json')
call assert_match('^⚑ Claude is waiting for you Bash permission', CairnLines($HOME . '/project')[1])

" French when asked
let g:cairn_lang = 'fr'
call assert_match('^1/4 étapes · 25 %', CairnLines($HOME . '/project')[2])
let g:cairn_lang = 'en'

" the panel opens, shows the roadmap, then closes
execute 'cd ' . fnameescape($HOME . '/project')
Cairn
call assert_true(bufwinnr('cairn://roadmap') > 0)
call assert_equal('cairn · project', getbufline(bufnr('cairn://roadmap'), 1)[0])
Cairn
call assert_equal(-1, bufwinnr('cairn://roadmap'))

if !empty(v:errors)
  call writefile(v:errors, '/dev/stderr')
  cquit
endif
call writefile(['ok'], '/dev/stdout')
qall!
