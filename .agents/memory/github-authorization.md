---
name: GitHub authorization verification
description: Verify GitHub CLI access rather than trusting the connection card before publishing.
---

Treat GitHub authorization as unverified until an authenticated provider operation succeeds.

**Why:** In this workspace, the platform reported a healthy connected GitHub provider while `gh` had no login and Git authentication failed. Reconnection forms also rejected the supposedly connected provider.

**How to apply:** Verify account identity and repository permissions before creating or publishing repositories. If CLI access and connection status disagree, do not request credentials in chat or silently use a different account. Use the integration recovery flow, and report the blocker if recovery cannot open.

When repeated integration reconnection fails to provide CLI credentials, a GitHub token supplied through the secure Replit Secrets form is a working fallback. Verify its account identity before use and scan the token as well as the CFBD key before publishing.

**Why:** The integration remained unusable after reconnection, but a securely supplied token restored authenticated GitHub access.

**How to apply:** Keep credentials out of Git URLs, command arguments, tracked configuration, and command-error logs. Use environment-based authentication and fail explicitly when credentials expire.

Automated publishing must supply a credential-free Git author identity rather than relying on interactive Shell configuration.

**Why:** Publishing worked from the Shell but the managed API server failed at `git commit`. Supplying an explicit bot identity fixed server-side commits.

**How to apply:** Preserve the per-command bot identity for background publication. Verify publishing from the managed server, not only a CLI fixture, before considering it working.

Authorized workspace Git writes may require an explicit `DANGEROUSLY_ALLOW_GIT=1` prefix when the platform's Git-directory guard requests it.

**Why:** The workspace guard rejected a normal `git fetch` with its increased-scrutiny message despite valid GitHub authorization.

**How to apply:** Retry only the user-authorized, non-destructive Git operation with the requested prefix. This is not permission to reset history or bypass approval for destructive changes.
