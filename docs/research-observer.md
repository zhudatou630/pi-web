# Research Loop in the main workspace

The sidebar's **研究观察** link opens `/?research=latest` in the normal Pi Web workspace. An existing research run can be opened directly with `/?research=<run-id>`. The research dashboard provides **在主界面只读观察** for the selected run.

This is an observer of the existing backend run, not a native Pi AgentSession. Claude CLI jobs do not automatically create Pi chat sessions. Opening, switching, or closing the observer does not start a model, change the executor, pause/resume a run, acknowledge a request, or send an experiment instruction. Existing Pi-executor agent-session links remain separate.

The main conversation area presents actual assistant replies, tool calls/results, workflow events, archived rounds, and PDF/TeX/CSV/ZIP links. Human requests link to the original research dashboard for handling. The observer has no prompt composer. Normal chat can be restored with **返回聊天** or by selecting a chat.

The browser polls a GET-only Next route every three seconds. That route reads the existing backend state and bounded tails of backend-selected log files. It accepts a validated run ID, never a client-supplied filename. Real paths must remain inside the run's logs directory, including junction/symlink checks. The private service token stays server-side. Known credential patterns are filtered; reasoning blocks, init settings and image payloads are omitted.

Display limits are six recent logs, 384 KiB per log, 160 recent stream records, 6,000 characters per displayed record and 200 workflow events. Long records are explicitly marked as shortened. Complete original records remain in the research dashboard. A file's start time is labelled as such; it is not presented as the exact timestamp of every tool event.

No Python backend or experiment workspace change is required, so an already-running Claude CLI research job can be observed without a worker restart. Tests in `lib/research-observer.test.mjs` cover stream parsing, credentials, read-only dispatch, bounded UTF-8 reads and log-path boundaries. Existing research bridge and typography checks also apply.
