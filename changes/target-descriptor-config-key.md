---
packages: [core]
kind: Added
---
`TargetDescriptor.configKey?: string` names the `mx[<key>]` config block a target reads (`defaultTag` today), when it is not the target's own `name`; defaults to the target's name. A bare word, validated at load. The tree target sets `configKey: "data"`, so the decision-187 rename does not move `mx.data.*`.
