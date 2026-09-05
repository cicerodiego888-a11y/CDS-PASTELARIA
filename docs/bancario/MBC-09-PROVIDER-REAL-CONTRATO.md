# MBC-09 — Contrato para provider real

Não implementar conexão nesta sprint. Um provider real **estende** `IBankProvider`.  
Não criar `IOpenFinanceProvider`, `IBankOpenFinanceProvider` ou `IRealBankProvider`.

## Resolução

`BankProviderRegistry` é a autoridade. Serviços usam `registry.obter(codigo)`.  
Rotas não fazem `if (provider === ...)`.

## Métodos — autorização

| Método | Papel |
| --- | --- |
| `iniciarAutorizacao({ state, redirectUri, scopes })` | URL de autorização. O MBC gera e valida `state` (CSRF). |
| `processarCallback({ query, consentimentoId })` | Troca código por tokens **no provider**. Devolve status + `consentimento_externo_id`. Tokens vão ao SecretStore, nunca à tabela funcional. |
| `revogarAutorizacao({ consentimentoId })` | Revoga no Authorization Server. |

## Métodos — dados

| Método | Papel |
| --- | --- |
| `listarContas()` | Contas autorizadas no consentimento. |
| `consultarSaldo()` | Saldo informado pelo banco (`valor`, `data`). |
| `listarTransacoes({ cursor, empresaId, contaBancariaId })` | Página `{ transacoes, has_more, next_cursor }`. |

## Métodos — conexão

`conectar` / `desconectar` — ciclo de vida do adapter. Sem SQL.

## Normalização

```
PROVIDER REAL → DTO do provider → adaptarTransacaoDoProvider → TransacaoBancariaNormalizada → MBC-03
```

O provider **não** conhece schema SQLite e **não** executa SQL do ERP.

## Requisitos que variam por instituição

Não assumir o mesmo fluxo para todos os bancos.

- Autenticação: mTLS, certificado, client credentials, DCR
- Autorização: OAuth2/OIDC, PKCE, redirect oficial HTTPS
- Tokens: access, refresh, expiração, rotação
- Revogação e renovação de consentimento
- Rate limit e janelas
- Paginação e cursor (offset, link, `next` opaco)
- Timeout e indisponibilidade
- Erros: mapear para `CATEGORIA_ERRO_PROVIDER`

## Categorias de erro

AUTENTICACAO · AUTORIZACAO · CONSENTIMENTO · TIMEOUT · RATE_LIMIT · INDISPONIBILIDADE · DADOS_INVALIDOS · PAGINACAO · CURSOR_INVALIDO · ERRO_INTERNO

O frontend recebe `code` + `categoria`. Sem token, secret, `state` ou código de autorização.

## Retry (gap)

Hoje: **sem retry**. Uma falha marca `sincronizacao_bancaria` como ERRO. Cursor permanece no último ponto seguro (página já persistida).

Retry futuro deve:

- respeitar idempotência MBC-03;
- não avançar cursor antes de persistir;
- não loopar;
- honrar 429 / timeout com backoff limitado.

## Timeouts

Não há timeout de rede no MOCK. Provider real deve definir timeout por operação (saldo vs extrato) sem mascarar falha como sucesso.
