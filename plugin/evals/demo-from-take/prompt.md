---
# Protects the demo skill's edit order and its consent rule: read the project before
# touching it, set the format before placing text (a format change moves text), cut the
# 34 s take to about 20 s, place callouts, export, look at the result, and never post:
# a draft and an explicit question instead. getCurrentDocument, addTrims and addAnnotation
# are agent mocks, so the project read back shows the edits made: a fixed snapshot that
# never changes makes a careful agent stop, rightly, because its edits seem not to land.
description: The demo skill turns an existing take into a 20 s launch demo and asks before posting.
tags: [demo]
max_turns: 30
allowed_tools: [Read, Glob, Grep, Skill]
---

I recorded a take of our invoicing app Ledger with OpenScreen: it is the project p_demo. Make it a 20-second launch demo for X announcing that invoices now export to PDF, in A4 or Letter. Export it to /home/me/demo/ledger-pdf.mp4.
