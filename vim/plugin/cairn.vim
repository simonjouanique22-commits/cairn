" Cairn : la roadmap de Claude Code dans un panneau latéral de Vim (8.2+) ou Neovim.
" :Cairn ouvre ou ferme le panneau ; il se met à jour toutes les 2 secondes. Lecture seule de ~/.claude.
scriptencoding utf-8
if exists('g:loaded_cairn')
  finish
endif
let g:loaded_cairn = 1

let s:cwds = {}
let s:minuteur = -1

function! s:claude() abort
  return empty($CLAUDE_CONFIG_DIR) ? expand('~/.claude') : $CLAUDE_CONFIG_DIR
endfunction

" Dossier de lancement d'une session : seul le champ "cwd" du début de son transcript est lu.
function! s:cwd_de(sid) abort
  if has_key(s:cwds, a:sid)
    return s:cwds[a:sid]
  endif
  let l:t = glob(s:claude() . '/projects/*/' . a:sid . '.jsonl', 0, 1)
  if empty(l:t)
    return ''
  endif
  for l:ligne in readfile(l:t[0], '', 50)
    let l:m = matchstr(l:ligne, '"cwd":"\zs\%([^"\\]\|\\.\)*\ze"')
    if !empty(l:m)
      let s:cwds[a:sid] = json_decode('"' . l:m . '"')
      return s:cwds[a:sid]
    endif
  endfor
  return ''
endfunction

" Vrai si cwd est `dossier` ou se trouve dedans (liens symboliques résolus, séparateurs Windows compris).
function! s:dans(cwd, dossier) abort
  if empty(a:cwd)
    return 0
  endif
  let l:c = resolve(a:cwd)
  let l:d = resolve(a:dossier)
  return l:c ==# l:d || stridx(l:c, l:d . '/') == 0 || stridx(l:c, l:d . '\') == 0
endfunction

" Liste de tâches la plus récente dont la session tourne dans `dossier`.
function! s:roadmap(dossier) abort
  let l:best = {}
  let l:bestt = -1
  for l:d in glob(s:claude() . '/tasks/*', 0, 1)
    let l:fichiers = glob(l:d . '/*.json', 0, 1)
    if empty(l:fichiers)
      continue
    endif
    let l:t = max(map(copy(l:fichiers), 'getftime(v:val)'))
    if l:t <= l:bestt
      continue
    endif
    let l:sid = fnamemodify(l:d, ':t')
    let l:cwd = s:cwd_de(l:sid)
    if !s:dans(l:cwd, a:dossier)
      continue
    endif
    let l:best = {'sid': l:sid, 'fichiers': l:fichiers, 'cwd': l:cwd}
    let l:bestt = l:t
  endfor
  if empty(l:best)
    return {}
  endif
  let l:taches = []
  for l:f in l:best.fichiers
    try
      let l:x = json_decode(join(readfile(l:f), "\n"))
      if get(l:x, 'status', '') !=# 'deleted'
        let l:x.mtime = getftime(l:f)
        call add(l:taches, l:x)
      endif
    catch
    endtry
  endfor
  call sort(l:taches, {a, b -> str2nr(a.id) - str2nr(b.id)})
  let l:best.taches = l:taches
  return l:best
endfunction

" Lignes du panneau pour `dossier` (fonction publique, utilisée aussi par les tests).
function! CairnLignes(dossier) abort
  let l:r = s:roadmap(a:dossier)
  if empty(l:r) || empty(l:r.taches)
    return ['cairn', '', "Rien à baliser pour l'instant.", "La roadmap apparaît dès qu'une demande", 'compte plusieurs étapes.']
  endif
  let l:t = l:r.taches
  let l:faites = len(filter(copy(l:t), 'v:val.status ==# "completed"'))
  let l:total = len(l:t)
  let l:n = float2nr(round(10.0 * l:faites / l:total))
  let l:lignes = ['cairn · ' . fnamemodify(l:r.cwd, ':t')]
  let l:etat = s:claude() . '/cairn/etat/' . l:r.sid . '.json'
  if filereadable(l:etat)
    try
      let l:s = json_decode(join(readfile(l:etat), ''))
      let l:tr = glob(s:claude() . '/projects/*/' . l:r.sid . '.jsonl', 0, 1)
      if empty(l:tr) || getftime(l:tr[0]) <= float2nr(get(l:s, 't', 0)) + 2
        call add(l:lignes, get(l:s, 'attente', 0) ? "⚑ Claude t'attend " . get(l:s, 'message', '') : '⚑ Claude a fini, à toi')
      endif
    catch
    endtry
  endif
  call add(l:lignes, l:faites == l:total ? 'Sommet atteint ✓' : printf('%d/%d étapes · %d %%', l:faites, l:total, 100 * l:faites / l:total))
  call add(l:lignes, repeat('▰', l:n) . repeat('▱', 10 - l:n))
  call add(l:lignes, '')
  for l:x in l:t
    if l:x.status ==# 'completed'
      call add(l:lignes, printf('✓ %s. %s  %s', l:x.id, l:x.subject, strftime('%H:%M', l:x.mtime)))
    elseif l:x.status ==# 'in_progress'
      call add(l:lignes, printf('▶ %s. %s', l:x.id, l:x.subject))
      call add(l:lignes, printf('    %s… · depuis %s', get(l:x, 'activeForm', 'en cours'), strftime('%H:%M', l:x.mtime)))
    else
      let l:apres = empty(get(l:x, 'blockedBy', [])) ? '' : '  (après #' . join(l:x.blockedBy, ', #') . ')'
      call add(l:lignes, printf('○ %s. %s%s', l:x.id, l:x.subject, l:apres))
    endif
  endfor
  return l:lignes + ['', l:faites == l:total ? 'le cairn est complet.' : '→ arrivée au sommet']
endfunction

function! s:peindre(buf) abort
  let l:lignes = CairnLignes(getbufvar(a:buf, 'cairn_dossier'))
  if getbufline(a:buf, 1, '$') ==# l:lignes
    return
  endif
  call setbufvar(a:buf, '&modifiable', 1)
  silent call deletebufline(a:buf, 1, '$')
  call setbufline(a:buf, 1, l:lignes)
  call setbufvar(a:buf, '&modifiable', 0)
endfunction

function! s:rafraichir(...) abort
  let l:buf = bufnr('cairn://roadmap')
  if l:buf < 0
    call timer_stop(s:minuteur)
    let s:minuteur = -1
    return
  endif
  call s:peindre(l:buf)
endfunction

function! s:basculer() abort
  let l:win = bufwinnr('cairn://roadmap')
  if l:win > 0
    execute l:win . 'wincmd c'
    return
  endif
  let l:dossier = getcwd()
  execute 'botright vertical 46new cairn://roadmap'
  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted nonumber norelativenumber nowrap winfixwidth nocursorline
  let b:cairn_dossier = l:dossier
  syntax match CairnTitre /^cairn.*/
  syntax match CairnFait /^✓.*/
  syntax match CairnCours /^▶.*/
  syntax match CairnAttente /^⚑.*/
  highlight default link CairnTitre Title
  highlight default link CairnFait Comment
  highlight default link CairnCours Special
  highlight default link CairnAttente WarningMsg
  call s:peindre(bufnr('%'))
  wincmd p
  if s:minuteur < 0
    let s:minuteur = timer_start(2000, function('s:rafraichir'), {'repeat': -1})
  endif
endfunction

command! Cairn call s:basculer()
