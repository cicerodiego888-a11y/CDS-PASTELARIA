# MBC-11 — Autorização real

**NÃO IMPLEMENTADA** contra instituição.

O fluxo oficial só pode ser escrito depois da documentação do provider.

Enquanto isso permanece o contrato MBC-06/MBC-10:

1. consentimento + `state` (`randomBytes`)
2. `iniciarAutorizacao`
3. callback valida state (uma vez)
4. tokens só no `ISecretStore` quando existirem
5. empresa não vem da URL

Sem Authorization Server, o adapter recusa execução (`disponivel === false`).
