# MBC-11 — Sincronização real

**NÃO HOMOLOGADA.**

MBC-07 continua dono de saldo, extrato, cursor e persistência via MBC-03.

O adapter só forneceria dados após endpoints oficiais por ambiente:

- `MBC_OF_REAL_*_SANDBOX`
- `MBC_OF_REAL_*_HOMOLOGACAO`
- `MBC_OF_REAL_*_PRODUCAO`

Produção não pode apontar para URL de sandbox/homologação.

Duas sincronizações consecutivas, quando houver provider oficial, devem continuar sem duplicidade (`empresa + conta + source + external_id`).
