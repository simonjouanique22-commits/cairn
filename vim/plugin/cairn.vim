" Cairn: Claude Code's roadmap in a Vim (8.2+) or Neovim side panel.
" :Cairn opens or closes the panel; it refreshes every 2 seconds. Reads ~/.claude only.
" Language: English, or French when g:cairn_lang (else v:lang) starts with "fr".
scriptencoding utf-8
if exists('g:loaded_cairn')
  finish
endif
let g:loaded_cairn = 1

let s:cwds = {}
let s:timer = -1
let s:T = {
      \ 'en': {'empty': ['Nothing to mark yet.', 'The roadmap shows up as soon as a request', 'has several steps.'],
      \        'waiting': '⚑ Claude is waiting for you ', 'done': '⚑ Claude is done — your turn', 'summit': 'Summit reached ✓',
      \        'count': '%d/%d steps · %d %%', 'since': '    %s… · since %s', 'busy': 'in progress', 'after': '  (after #%s)',
      \        'full': 'the cairn is complete.', 'foot': '→ on to the summit'},
      \ 'fr': {'empty': ["Rien à baliser pour l'instant.", "La roadmap apparaît dès qu'une demande", 'compte plusieurs étapes.'],
      \        'waiting': "⚑ Claude t'attend ", 'done': '⚑ Claude a fini, à toi', 'summit': 'Sommet atteint ✓',
      \        'count': '%d/%d étapes · %d %%', 'since': '    %s… · depuis %s', 'busy': 'en cours', 'after': '  (après #%s)',
      \        'full': 'le cairn est complet.', 'foot': '→ arrivée au sommet'}}

function! s:t() abort
  return s:T[get(g:, 'cairn_lang', v:lang) =~? '^fr' ? 'fr' : 'en']
endfunction

function! s:claude() abort
  return empty($CLAUDE_CONFIG_DIR) ? expand('~/.claude') : $CLAUDE_CONFIG_DIR
endfunction

" Folder a session was started in: only the "cwd" field near the top of its transcript is read.
function! s:cwd_of(sid) abort
  if has_key(s:cwds, a:sid)
    return s:cwds[a:sid]
  endif
  let l:t = glob(s:claude() . '/projects/*/' . a:sid . '.jsonl', 0, 1)
  if empty(l:t)
    return ''
  endif
  for l:line in readfile(l:t[0], '', 50)
    let l:m = matchstr(l:line, '"cwd":"\zs\%([^"\\]\|\\.\)*\ze"')
    if !empty(l:m)
      let s:cwds[a:sid] = json_decode('"' . l:m . '"')
      return s:cwds[a:sid]
    endif
  endfor
  return ''
endfunction

" True when cwd is `folder` or inside it (symlinks resolved, Windows separators included).
function! s:inside(cwd, folder) abort
  if empty(a:cwd)
    return 0
  endif
  let l:c = resolve(a:cwd)
  let l:d = resolve(a:folder)
  return l:c ==# l:d || stridx(l:c, l:d . '/') == 0 || stridx(l:c, l:d . '\') == 0
endfunction

" Most recent task list whose session runs in `folder`.
function! s:roadmap(folder) abort
  let l:best = {}
  let l:bestt = -1
  for l:d in glob(s:claude() . '/tasks/*', 0, 1)
    let l:files = glob(l:d . '/*.json', 0, 1)
    if empty(l:files)
      continue
    endif
    let l:t = max(map(copy(l:files), 'getftime(v:val)'))
    if l:t <= l:bestt
      continue
    endif
    let l:sid = fnamemodify(l:d, ':t')
    let l:cwd = s:cwd_of(l:sid)
    if !s:inside(l:cwd, a:folder)
      continue
    endif
    let l:best = {'sid': l:sid, 'files': l:files, 'cwd': l:cwd}
    let l:bestt = l:t
  endfor
  if empty(l:best)
    return {}
  endif
  let l:tasks = []
  for l:f in l:best.files
    try
      let l:x = json_decode(join(readfile(l:f), "\n"))
      if get(l:x, 'status', '') !=# 'deleted'
        let l:x.mtime = getftime(l:f)
        call add(l:tasks, l:x)
      endif
    catch
    endtry
  endfor
  call sort(l:tasks, {a, b -> str2nr(a.id) - str2nr(b.id)})
  let l:best.tasks = l:tasks
  return l:best
endfunction

" Panel lines for `folder` (public function, also used by the tests).
function! CairnLines(folder) abort
  let l:T = s:t()
  let l:r = s:roadmap(a:folder)
  if empty(l:r) || empty(l:r.tasks)
    return ['cairn', ''] + l:T.empty
  endif
  let l:t = l:r.tasks
  let l:done = len(filter(copy(l:t), 'v:val.status ==# "completed"'))
  let l:total = len(l:t)
  let l:n = float2nr(round(10.0 * l:done / l:total))
  let l:lines = ['cairn · ' . fnamemodify(l:r.cwd, ':t')]
  let l:state = s:claude() . '/cairn/state/' . l:r.sid . '.json'
  if filereadable(l:state)
    try
      let l:s = json_decode(join(readfile(l:state), ''))
      let l:tr = glob(s:claude() . '/projects/*/' . l:r.sid . '.jsonl', 0, 1)
      if empty(l:tr) || getftime(l:tr[0]) <= float2nr(get(l:s, 't', 0)) + 2
        call add(l:lines, get(l:s, 'waiting', 0) ? l:T.waiting . get(l:s, 'message', '') : l:T.done)
      endif
    catch
    endtry
  endif
  call add(l:lines, l:done == l:total ? l:T.summit : printf(l:T.count, l:done, l:total, 100 * l:done / l:total))
  call add(l:lines, repeat('▰', l:n) . repeat('▱', 10 - l:n))
  call add(l:lines, '')
  for l:x in l:t
    if l:x.status ==# 'completed'
      call add(l:lines, printf('✓ %s. %s  %s', l:x.id, l:x.subject, strftime('%H:%M', l:x.mtime)))
    elseif l:x.status ==# 'in_progress'
      call add(l:lines, printf('▶ %s. %s', l:x.id, l:x.subject))
      call add(l:lines, printf(l:T.since, get(l:x, 'activeForm', l:T.busy), strftime('%H:%M', l:x.mtime)))
    else
      let l:after = empty(get(l:x, 'blockedBy', [])) ? '' : printf(l:T.after, join(l:x.blockedBy, ', #'))
      call add(l:lines, printf('○ %s. %s%s', l:x.id, l:x.subject, l:after))
    endif
  endfor
  return l:lines + ['', l:done == l:total ? l:T.full : l:T.foot]
endfunction

function! s:paint(buf) abort
  let l:lines = CairnLines(getbufvar(a:buf, 'cairn_folder'))
  if getbufline(a:buf, 1, '$') ==# l:lines
    return
  endif
  call setbufvar(a:buf, '&modifiable', 1)
  silent call deletebufline(a:buf, 1, '$')
  call setbufline(a:buf, 1, l:lines)
  call setbufvar(a:buf, '&modifiable', 0)
endfunction

function! s:refresh(...) abort
  let l:buf = bufnr('cairn://roadmap')
  if l:buf < 0
    call timer_stop(s:timer)
    let s:timer = -1
    return
  endif
  call s:paint(l:buf)
endfunction

function! s:toggle() abort
  let l:win = bufwinnr('cairn://roadmap')
  if l:win > 0
    execute l:win . 'wincmd c'
    return
  endif
  let l:folder = getcwd()
  execute 'botright vertical 46new cairn://roadmap'
  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted nonumber norelativenumber nowrap winfixwidth nocursorline
  let b:cairn_folder = l:folder
  syntax match CairnTitle /^cairn.*/
  syntax match CairnDone /^✓.*/
  syntax match CairnCurrent /^▶.*/
  syntax match CairnWaiting /^⚑.*/
  highlight default link CairnTitle Title
  highlight default link CairnDone Comment
  highlight default link CairnCurrent Special
  highlight default link CairnWaiting WarningMsg
  call s:paint(bufnr('%'))
  wincmd p
  if s:timer < 0
    let s:timer = timer_start(2000, function('s:refresh'), {'repeat': -1})
  endif
endfunction

command! Cairn call s:toggle()
