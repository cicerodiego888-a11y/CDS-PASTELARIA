# MBC-12 — Provider real (prontidão)

**AGUARDANDO PROVIDER REAL / AMBIENTE OFICIAL**

Não houve chamada real por ausência de contrato oficial e/ou ambiente oficial.

Blogs, exemplos genéricos e documentação não oficial **não** são contrato.

## Inventário oficial

| Item | Registro |
|---|---|
| Instituição financeira / provider | não escolhido |
| Documentação oficial | ausente |
| Produto Open Finance | não identificado |
| Ambiente oficial | ausente |
| Endpoint oficial | ausente |
| Método de autenticação oficial | ausente |
| OAuth / autorização oficial | ausente |
| Redirect / callback oficial | ausente |
| Certificados exigidos | não aplicável |
| Scopes oficiais | ausentes |
| Credenciais de homologação | não recebidas |
| Identificação de conta | contrato desconhecido |
| Consulta de saldo | contrato desconhecido |
| Consulta de transações | contrato desconhecido |
| Paginação | contrato desconhecido |
| Cursor | contrato desconhecido |
| Rate limit | contrato desconhecido |
| Códigos de erro | contrato desconhecido |
| Política oficial de retry | contrato desconhecido |
| Requisitos de segurança | contrato desconhecido |
| Requisitos de produção | contrato desconhecido |

## `providerRealPodeOperar()`

Resultado atual: **false** (determinístico).

Motivos permanentes enquanto `INSTITUICAO_OFICIAL`, `DOCUMENTACAO_OFICIAL_URL` e `PRODUTO_OPEN_FINANCE_OFICIAL` forem nulos:

- `AGUARDANDO_PROVIDER_REAL_AMBIENTE_OFICIAL`

Também recusa se:

- `MBC_OPEN_FINANCE_REAL_ENABLED` ≠ `true` (padrão: desligada);
- endpoints oficiais ausentes (`MBC_OF_REAL_HABILITADO` + URLs);
- mismatch de ambiente (`ambienteEndpointValido` → HTTP 409);
- PRODUÇÃO sem `MBC_SECRET_STORE_KEY`;
- consentimento ≠ `AUTORIZADO`.

Mensagem pt-BR: **Este provider ainda não está habilitado para operação real.**

Nenhuma chamada HTTP é feita nesta validação.

## Feature flag

`MBC_OPEN_FINANCE_REAL_ENABLED` padrão `false`. Sozinha **não** habilita produção.

## SecretStore

Somente `ISecretStore`. Sem Vault/HSM de produção no MBC → operação de PRODUÇÃO bloqueada.

## Classificação

PROVIDER REAL PREPARADO, MAS NÃO IMPLEMENTADO
