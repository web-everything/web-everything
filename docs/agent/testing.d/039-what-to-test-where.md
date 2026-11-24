## What to test where

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| New class/function | Yes | Maybe | No |
| Bug fix | Yes (reproduce) | If cross-component | If user-visible |
| New public method | Yes | If uses injectors | No |
| Parser | Yes | Yes (with registry) | No |
| Attribute | Yes | Yes (with DOM) | Yes (user flow) |
| Store | Yes | Maybe | If in demo |
| Demo feature | No | No | Yes |

