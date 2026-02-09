# nl-nip46-relay-settings



<!-- Auto Generated Below -->


## Properties

| Property        | Attribute | Description                           | Type       | Default                       |
| --------------- | --------- | ------------------------------------- | ---------- | ----------------------------- |
| `defaultRelays` | --        | 親から渡される現在のリレーリスト（localStorage由来の場合あり） | `string[]` | `[...FACTORY_DEFAULT_RELAYS]` |


## Events

| Event             | Description | Type                    |
| ----------------- | ----------- | ----------------------- |
| `nlRelaysChanged` |             | `CustomEvent<string[]>` |


## Dependencies

### Used by

 - [nl-connect](../nl-connect)

### Graph
```mermaid
graph TD;
  nl-connect --> nl-nip46-relay-settings
  style nl-nip46-relay-settings fill:#f9f,stroke:#333,stroke-width:4px
```

----------------------------------------------

*Built with [StencilJS](https://stenciljs.com/)*
