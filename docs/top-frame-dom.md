# Top-frame DOM cooperation

Use ordinary cooperation unless Chrome denies debugger access because a foreign
extension frame is present. If the task can use synthetic input, the caller can
opt in on an owned task tab:

```sh
bsk cooperate sync --session "$session" --policy target --allow-top-frame-dom --settle
```

Only a reply with `backend: "top_frame_dom"` uses this backend. It also reports
`frame_scope: "top"`, `ax_available: false`, and `input_trust: "synthetic"`.
The refs belong to the returned context and top document. The observation does
not include child-frame contents or a browser accessibility tree.

After inspecting that reply, explicitly accept DOM dispatch for each mutation:

```sh
bsk fill @e1 --session "$session" --context "$context" --accept-dom-dispatch \
  --expect '[{"target":"@e1","field":"value","equals":""}]' --value 'example'
bsk click @e2 --session "$session" --context "$context" --accept-dom-dispatch \
  --expect '[{"target":"@e2","field":"text","equals":"Apply"}]'
```

The same opt-ins are `allow_top_frame_dom: true` on sync and
`accept_dom_dispatch: true` on fill or click in the wire/MCP APIs. Both the
daemon and extension must support `top_frame_dom_v1` (protocol 1.10). There is
no automatic downgrade for older clients. This backend supports replacing
ordinary field values and activating a button once, not arbitrary key or pointer
sequences. It does not grant user activation, and sites can reject untrusted
events.

If the reply says `effect_state: "unknown"`, do not replay the action. Inspect
the application result. Sync alone cannot reconcile a synthetic intent.
`bsk ledger resolve` requires proof that the original renderer command settled;
otherwise close the owned session instead of trying to reuse its authority.
