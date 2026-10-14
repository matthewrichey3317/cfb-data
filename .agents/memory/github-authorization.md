---
name: GitHub authorization verification
description: Verify GitHub CLI access rather than trusting the connection card before publishing.
---

Treat GitHub authorization as unverified until an authenticated provider operation succeeds.

**Why:** In this workspace, the platform reported a healthy connected GitHub provider while `gh` had no login and Git authentication failed. Reconnection forms also rejected the supposedly connected provider.

**How to apply:** Verify account identity and repository permissions before creating or publishing repositories. If CLI access and connection status disagree, do not request credentials in chat or silently use a different account. Use the integration recovery flow, and report the blocker if recovery cannot open.
