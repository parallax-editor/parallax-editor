# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill in the form with as much detail as you can.

We'll acknowledge the report within 72 hours and aim to ship a fix or
mitigation within 14 days for high-severity issues. We coordinate disclosure
publicly only after a fix is available.

## Scope

In scope:
- Code in this repository at the latest release tag.
- Documented usage paths.

Out of scope:
- Vulnerabilities in third-party dependencies (please report those upstream).
- Issues that require physical access to the user's machine.
- Self-XSS that requires the user to paste arbitrary code into a browser
  console.

## Recognition

We're a small open source project; we can't offer bug bounties. We'll credit
reporters in the release notes for the fix unless you prefer to remain
anonymous.
