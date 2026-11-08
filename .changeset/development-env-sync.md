---
"affect-cli": patch
---

Add `affect env sync-dev [--force]` to synchronize settings from an explicit encrypted development profile and shared Convex server declaration. Verify the hosted development identity and canonical URLs before any update, preserve bulk conflict semantics, and keep credentials and values out of output. This command does not deploy backend code or build the frontend.
