# IntelliGit Localization Glossary

Canonical translations for Git terminology and recurring UI verbs. Every
translator (human or AI first-draft) MUST follow this table so terms stay
consistent across the manifest, extension-host, and webview surfaces.

## Sourcing rule

Anchor each term to **VS Code's own built-in Git localization** for that locale.
Where VS Code keeps the English word (common for `commit`, `rebase`, `stash`,
`push`, `pull`, `fetch` in CJK and several European locales), keep it too. This
matters more than literal accuracy: a user who knows VS Code's German Git UI
must recognize IntelliGit's German Git UI.

> Status: AI first-draft. Pending native-speaker / VS Code-l10n verification per
> the agreed pipeline (AI draft -> glossary review -> screenshot QA).

## Core Git nouns

| EN             | de                   | es                  | fr                | ja               | ko             | pl                | pt-br                 | pt-pt                  | ru                  | zh-cn    | zh-tw    |
| -------------- | -------------------- | ------------------- | ----------------- | ---------------- | -------------- | ----------------- | --------------------- | ---------------------- | ------------------- | -------- | -------- |
| commit (n)     | Commit               | confirmación        | commit            | コミット         | 커밋           | commit            | commit                | commit                 | коммит              | 提交     | 提交     |
| commit (v)     | committen            | confirmar           | valider           | コミット         | 커밋           | commit            | commitar              | submeter               | сделать коммит      | 提交     | 提交     |
| branch         | Branch               | rama                | branche           | ブランチ         | 브랜치         | gałąź             | branch                | ramo                   | ветка               | 分支     | 分支     |
| merge          | Zusammenführen       | fusión              | fusion            | マージ           | 병합           | scalanie          | mesclar               | integrar               | слияние             | 合并     | 合併     |
| merge conflict | Mergekonflikt        | conflicto de fusión | conflit de fusion | マージ競合       | 병합 충돌      | konflikt scalania | conflito de mesclagem | conflito de integração | конфликт слияния    | 合并冲突 | 合併衝突 |
| rebase         | Rebase               | reorganizar         | rebaser           | リベース         | 리베이스       | rebase            | rebase                | rebase                 | перебазирование     | 变基     | 變基     |
| stash          | Stash                | guardar (stash)     | remiser           | スタッシュ       | 스태시         | schowek           | stash                 | stash                  | спрятать            | 储藏     | 儲藏     |
| checkout       | Auschecken           | desprotección       | extraire          | チェックアウト   | 체크아웃       | przełącz          | fazer checkout        | obter                  | переключение        | 检出     | 簽出     |
| remote         | Remote               | remoto              | distant           | リモート         | 원격           | zdalne            | remoto                | remoto                 | удалённый           | 远程     | 遠端     |
| upstream       | Upstream             | upstream            | en amont          | アップストリーム | 업스트림       | upstream          | upstream              | upstream               | вышестоящая ветка   | 上游     | 上游     |
| cherry-pick    | Cherry-Pick          | selección           | picorer           | チェリーピック   | 체리픽         | cherry-pick       | cherry-pick           | cherry-pick            | отбор коммита       | 拣选     | 揀選     |
| squash         | Squash               | combinar            | écraser           | スカッシュ       | 스쿼시         | spłaszcz          | squash                | squash                 | объединение         | 压缩     | 壓縮     |
| amend          | Ergänzen             | enmendar            | modifier          | 修正             | 수정           | popraw            | corrigir              | corrigir               | дополнить           | 修订     | 修訂     |
| staged         | Bereitgestellt       | preparado           | indexé            | ステージ済み     | 스테이징됨     | przygotowane      | preparado             | preparado              | проиндексировано    | 已暂存   | 已暫存   |
| unstaged       | Nicht bereitgestellt | sin preparar        | non indexé        | 未ステージ       | 스테이징 안 됨 | nieprzygotowane   | não preparado         | não preparado          | не проиндексировано | 未暂存   | 未暫存   |
| discard        | Verwerfen            | descartar           | abandonner        | 破棄             | 취소           | odrzuć            | descartar             | descartar              | отменить            | 放弃     | 捨棄     |
| rollback       | Zurücksetzen         | revertir            | annuler           | ロールバック     | 롤백           | wycofaj           | reverter              | reverter               | откат               | 回滚     | 回復     |

## Core Git verbs (kept short for buttons/menus)

| EN         | de              | es          | fr          | ja       | ko       | pl        | pt-br          | pt-pt          | ru               | zh-cn  | zh-tw  |
| ---------- | --------------- | ----------- | ----------- | -------- | -------- | --------- | -------------- | -------------- | ---------------- | ------ | ------ |
| Push       | Pushen          | insertar    | push        | プッシュ | 푸시     | wypchnij  | enviar (push)  | enviar (push)  | отправить        | 推送   | 推送   |
| Pull       | Pullen          | extraer     | pull        | プル     | 풀       | zaciągnij | receber (pull) | receber (pull) | получить         | 拉取   | 拉取   |
| Fetch      | Abrufen         | recuperar   | récupérer   | フェッチ | 가져오기 | pobierz   | buscar         | obter          | извлечь          | 提取   | 提取   |
| Clone      | Klonen          | clonar      | cloner      | クローン | 복제     | sklonuj   | clonar         | clonar         | клонировать      | 克隆   | 複製   |
| Publish    | Veröffentlichen | publicar    | publier     | 公開     | 게시     | opublikuj | publicar       | publicar       | опубликовать     | 发布   | 發佈   |
| Initialize | Initialisieren  | inicializar | initialiser | 初期化   | 초기화   | zainicjuj | inicializar    | inicializar    | инициализировать | 初始化 | 初始化 |

## Recurring UI verbs (non-Git)

| EN           | de              | es            | fr              | ja               | ko          | pl              | pt-br         | pt-pt         | ru             | zh-cn    | zh-tw    |
| ------------ | --------------- | ------------- | --------------- | ---------------- | ----------- | --------------- | ------------- | ------------- | -------------- | -------- | -------- |
| Refresh      | Aktualisieren   | actualizar    | actualiser      | 更新             | 새로 고침   | odśwież         | atualizar     | atualizar     | обновить       | 刷新     | 重新整理 |
| Search       | Suchen          | buscar        | rechercher      | 検索             | 검색        | szukaj          | pesquisar     | pesquisar     | поиск          | 搜索     | 搜尋     |
| Clear        | Löschen         | borrar        | effacer         | クリア           | 지우기      | wyczyść         | limpar        | limpar        | очистить       | 清除     | 清除     |
| Expand All   | Alle erweitern  | expandir todo | tout développer | すべて展開       | 모두 펼치기 | rozwiń wszystko | expandir tudo | expandir tudo | развернуть всё | 全部展开 | 全部展開 |
| Collapse All | Alle reduzieren | contraer todo | tout réduire    | すべて折りたたみ | 모두 접기   | zwiń wszystko   | recolher tudo | recolher tudo | свернуть всё   | 全部折叠 | 全部摺疊 |

## IntelliGit Shelf terms

`Shelf`/`Shelve` are IntelliGit's patch-based recovery feature, not Git-native
`stash`. Keep this distinction in all locales: use the established `stash`
term only for Git Stash surfaces, and use the Shelf terms below for the
IntelliGit feature. The entries remain AI first-drafts under the sourcing rule
above and require native-speaker / VS Code-l10n verification.

| EN                | de                              | es                        | fr                         | ja               | ko             | pl                   | pt-br                     | pt-pt                     | ru                             | zh-cn        | zh-tw        |
| ----------------- | ------------------------------- | ------------------------- | -------------------------- | ---------------- | -------------- | -------------------- | ------------------------- | ------------------------- | ------------------------------ | ------------ | ------------ |
| shelf (n)         | Ablage                          | estante                   | étagère                    | シェルフ         | 셸프           | półka                | prateleira                | prateleira                | полка                          | 搁置架       | 擱置架       |
| shelve (v)        | ablegen                         | guardar en estante        | mettre en étagère          | シェルフに保存   | 셸프에 저장    | odłóż na półkę       | guardar na prateleira     | guardar na prateleira     | поместить на полку             | 搁置         | 擱置         |
| unshelve          | aus Ablage wiederherstellen     | restaurar estante         | restaurer l'étagère        | シェルフから復元 | 셸프에서 복원  | przywróć z półki     | restaurar da prateleira   | restaurar da prateleira   | восстановить с полки           | 从搁置架恢复 | 從擱置架還原 |
| Save to Shelf     | In Ablage speichern             | Guardar en estante        | Enregistrer dans l'étagère | シェルフに保存   | 셸프에 저장    | Zapisz na półce      | Salvar na prateleira      | Guardar na prateleira     | Сохранить на полке             | 保存到搁置架 | 儲存到擱置架 |
| Already Unshelved | Bereits wiederhergestellt       | Ya restaurado             | Déjà restauré              | すでに復元済み   | 이미 복원됨    | Już przywrócono      | Já restaurado             | Já restaurado             | Уже восстановлено              | 已恢复       | 已還原       |
| Unshelve Silently | Ohne Rückfrage wiederherstellen | Restaurar silenciosamente | Restaurer silencieusement  | 確認なしで復元   | 확인 없이 복원 | Przywróć bez pytania | Restaurar silenciosamente | Restaurar silenciosamente | Восстановить без подтверждения | 静默恢复     | 靜默還原     |
| shelf recovery    | Ablage-Wiederherstellung        | recuperación de estante   | récupération de l'étagère  | シェルフ復旧     | 셸프 복구      | odzyskiwanie półki   | recuperação da prateleira | recuperação da prateleira | восстановление полки           | 搁置恢复     | 擱置復原     |

## Do NOT translate

Brand name `IntelliGit`; product names `GitHub`, `GitLab`, `JetBrains`,
`PyCharm`, `WebStorm`, `IntelliJ IDEA`; codicon tokens like `$(add)`,
`$(edit)`, `$(github)`; CLI flags (`-m`, `api`, `read_repository`); URLs and
example hosts; `SSH`, `HTTPS`, `URL`, `Git`.

Runtime template placeholders must be preserved exactly as-is, including braces
and casing. Keep tokens such as `{message}`, `{path}`, `{count}`, `{branch}`,
`{remote}`, `{remoteBranch}`, `{short}`, `{title}`, `{detail}`, `{name}`,
`{url}`, `{repo}`, `{provider}`, `{fileName}`, `{number}`, `{tag}`,
`{oldBranch}`, `{newBranch}`, `{target}`, `{head}`, `{rollbackMessage}`, and
`{hintText}` verbatim. Tooling such as Google Sheets can corrupt placeholders;
do not add or remove braces, translate placeholder names, or change casing.
