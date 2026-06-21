# nl-connect

<!-- Auto Generated Below -->

## Properties

| Property                   | Attribute       | Description | Type                 | Default                  |
| -------------------------- | --------------- | ----------- | -------------------- | ------------------------ |
| `authMethods`              | --              |             | `AuthMethod[]`       | `[]`                     |
| `connectionStringServices` | --              |             | `ConnectionString[]` | `[]`                     |
| `hasOTP`                   | `has-o-t-p`     |             | `boolean`            | `false`                  |
| `titleWelcome`             | `title-welcome` |             | `string`             | `'Connect to key store'` |

## Events

| Event            | Description | Type                            |
| ---------------- | ----------- | ------------------------------- |
| `nlNostrConnect` |             | `CustomEvent<ConnectionString>` |

## Dependencies

### Used by

- [nl-auth](../nl-auth)

### Depends on

- [nl-nip46-relay-settings](../nl-nip46-relay-settings)
- [button-base](../button-base)

### Graph

```mermaid
graph TD;
  nl-connect --> nl-nip46-relay-settings
  nl-connect --> button-base
  nl-auth --> nl-connect
  style nl-connect fill:#f9f,stroke:#333,stroke-width:4px
```

---

_Built with [StencilJS](https://stenciljs.com/)_
