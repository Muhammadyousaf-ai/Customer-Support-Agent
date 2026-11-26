---
title: Troubleshooting Guide
category: technical
version: "2025-01"
---

# Login problems
<!-- tiers: all; contracts: all -->

If a customer cannot log in, ask them to reset the password from the sign-in page, clear cookies and try again in a private browser window. Verify that the email address on the account is correct. If the problem continues after a password reset, escalate to a human agent.

# API rate limits and 429 errors
<!-- tiers: all; contracts: all -->

An HTTP 429 response means the daily or per-minute API limit was exceeded. Free accounts allow 60 requests per minute, Basic 300, Pro 600. Enterprise limits are set in the contract. Wait for the Retry-After header duration, reduce request bursts, or upgrade the plan for higher limits.

# Webhook delivery failures
<!-- tiers: pro, enterprise; contracts: all -->

Webhooks are available on Pro and Enterprise. Failed deliveries are retried six times over 24 hours with exponential backoff. Check that the endpoint returns a 2xx status within 10 seconds and that the signing secret matches the dashboard. Basic and Free plans do not include webhooks.

# Priority support
<!-- tiers: pro, enterprise; contracts: all -->

Priority support is available to Pro (four hour response target) and Enterprise (one hour for urgent issues). Free and Basic customers receive standard support with a response within two business days.

# Data export problems
<!-- tiers: all; contracts: all -->

Data exports are generated in the background and the download link is emailed when ready, usually within 15 minutes. If no email arrives after an hour, check the spam folder and confirm the account email, then escalate to a human agent.
