# zstack-pane

`/zstack-pane` (or `/zs`) opens a pane with the current zstack run. It answers "status?", "is it stuck?" and "any hanging tasks?" without asking the manager.

- Header: goal, run id, state, agents spawned/max, active/max_parallel, time of the last refresh.
- Agents (id, role, harness/model, state, task, unread) and tasks (id, state, owner, rounds, title). When the pane is narrow, the least useful columns are dropped first.
- The last 5 `blocker` and `question` messages from `zstack msg log`.
- A field that sends `zstack msg send --as user --to all --kind steer`. It is sent as `user`, not `manager`, so the manager also gets the steer: zstack never delivers a message back to its sender.
- Refreshes every 3 s while open. Closing it stops the timer.

Limits: it reads only the default run (`$ZSTACK_RUN` or the last `zstack init`). With no run it shows `no zstack run — start one with zstack`. Mobile has no input field, so it has no steer field there. If zstack fails, the pane shows the error and keeps polling. It never blocks anything, so it has no fail-closed path.
