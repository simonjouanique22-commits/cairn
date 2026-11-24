" vim -Nu NONE -Es -S vim/test.vim — vérifie le plugin sur un faux ~/.claude ; code de sortie 1 si un contrôle échoue.
set encoding=utf-8
scriptencoding utf-8
let s:racine = expand('<sfile>:p:h')
let $HOME = tempname()
let $CLAUDE_CONFIG_DIR = ''
let s:c = $HOME . '/.claude'
call mkdir(s:c . '/tasks/s1', 'p')
call mkdir(s:c . '/projects/p', 'p')
call mkdir($HOME . '/projet', 'p')
call writefile(['{"type":"user","cwd":"' . $HOME . '/projet"}'], s:c . '/projects/p/s1.jsonl')
call writefile(['{"id":"1","subject":"Lire","status":"completed"}'], s:c . '/tasks/s1/1.json')
call writefile(['{"id":"2","subject":"Coder","activeForm":"Codage","status":"in_progress"}'], s:c . '/tasks/s1/2.json')
call writefile(['{"id":"3","subject":"Tester","status":"pending","blockedBy":["2"]}'], s:c . '/tasks/s1/3.json')
call writefile(['{"id":"10","subject":"Relire","status":"pending"}'], s:c . '/tasks/s1/10.json')

execute 'source ' . s:racine . '/plugin/cairn.vim'

let s:l = CairnLignes($HOME . '/projet')
call assert_equal('cairn · projet', s:l[0])
call assert_match('^1/4 étapes · 25 %', s:l[1])
call assert_match('^✓ 1\. Lire', s:l[4])
call assert_equal('▶ 2. Coder', s:l[5])
call assert_match('Codage… · depuis', s:l[6])
call assert_equal('○ 3. Tester  (après #2)', s:l[7])
call assert_equal('○ 10. Relire', s:l[8])
call assert_match("Rien à baliser", join(CairnLignes('/ailleurs')))

" Claude attend : signalé tant que le transcript n'a pas bougé depuis
call mkdir(s:c . '/cairn/etat', 'p')
call writefile(['{"attente": true, "message": "permission Bash", "t": ' . (localtime() + 60) . '}'], s:c . '/cairn/etat/s1.json')
call assert_match("^⚑ Claude t'attend permission Bash", CairnLignes($HOME . '/projet')[1])

" le panneau s'ouvre, affiche la roadmap, puis se referme
execute 'cd ' . fnameescape($HOME . '/projet')
Cairn
call assert_true(bufwinnr('cairn://roadmap') > 0)
call assert_equal('cairn · projet', getbufline(bufnr('cairn://roadmap'), 1)[0])
Cairn
call assert_equal(-1, bufwinnr('cairn://roadmap'))

if !empty(v:errors)
  call writefile(v:errors, '/dev/stderr')
  cquit
endif
call writefile(['ok'], '/dev/stdout')
qall!
