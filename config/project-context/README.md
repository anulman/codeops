# Project-context baselines

CodeOps supplies generic `AGENTS.md` and `SOUL.md` baselines. They define the
control-plane safety boundary and the technical product writing standard.
The quickstart chart uses these files when the matching values are empty.

A repository operator can extend or replace either baseline. Keep stricter
repository instructions when they do not conflict with the control-plane
safety boundary.

The other five context documents do not have generic defaults:

- `CURRENT-STATE.md`
- `DECISIONS.md`
- `DOMAIN.md`
- `PRODUCT.md`
- `SOURCE-MAP.md`

These documents describe one repository. The operator must supply exact,
reviewed content for them. CodeOps must not invent repository state, product
decisions, domain facts, or source authority.
