---
packages: [core, parser]
kind: Changed
---

The hint for JSX-style braces around an attribute value no longer names MX, because a dialect's files see it too (decision 212 item 10): `Attribute values in MX are plain TypeScript expressions, not JSX; remove the wrapping { }.` becomes `Attribute values are plain TypeScript expressions, not JSX; remove the wrapping { }.`
