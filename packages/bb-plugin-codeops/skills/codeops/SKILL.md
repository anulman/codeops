---
name: codeops
description: Inspect and advance explicitly admitted CodeOps runs through the CodeOps plugin.
---

Use `bb codeops command '<JSON>'` or `codeops_command` for the shared command
surface. Read the package README for the complete start schema. Start only
when the user has authorized implementation in the native project.

Inspect with `{"op":"list"}` and `{"op":"get","id":"..."}`. Reconcile
with `{"op":"reconcile","id":"..."}`. Pause, resume and cancel require
`id` and the current `revision`. Preserve existing run IDs and keys.

A turn ending is not completion. Do not submit fabricated approval, test or
review evidence. Do not
bypass blocked isolation, uncertain effects, review boundaries or human merge,
release and deployment gates. This version uses manual publication and bb’s shared reviewer trust model.
