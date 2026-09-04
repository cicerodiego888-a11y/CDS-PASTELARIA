# SPRINT 05.68

STATUS: CONCLUÍDA

PRODUÇÃO ALTERADA: SIM — somente `existeCompraComChave` e a chamada em `persistirDocumentoDfe` (`CentralDfePersistenciaService.js`)

FUNÇÃO: `existeCompraComChave`

CHAMADORES:
- `persistirDocumentoDfe` (único caller de produção; passa `empresaIdOperacao`)
- `CentralSincronizacaoService` (ctor `{ empresaId }` do alvo)
- DistDFe / `CentralUploadService` (já passam `dados.empresaId`)
- POST `/api/compras`: não chama (05.67 intacto)
- certificação / rc6.x: mocks `async () => false`

CONSULTA ANTERIOR:
`SELECT id FROM compras WHERE chave_acesso = ? LIMIT 1`

CONSULTA NOVA:
`SELECT id FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1`  
sem `empresaId`/`this._empresaId` válido: `false` (não consulta global)

FONTE DO empresaId:
`dados.empresaId` ?? `this._empresaId` (alvo da Central 05.54/05.55). Contexto autoriza; o alvo define a empresa.

EMPRESA A + X: `true` (encontrada)

EMPRESA B + X: `false` (não encontra a compra A)

MULTIEMPRESA: A+X, B+X, C+X coexistentes; cada alvo só o próprio registro

NULL: `empresa_id` NULL + X não é compra da A; sem COALESCE

CROSS-COMPANY: PASSOU (boolean; sem id/fornecedor/empresa da outra)

TESTES: 8/8 (`tests/central-entradas/isolamento-chave-compra-05-68.test.js`)

REGRESSÕES (2026-08-29):
05.68 8/8 · 05.67 8/8 · 05.66 8/8 · 05.65 10/10 · 05.64 8/8 · 05.63 10/10 · 05.62 8/8 · 05.61 8/8 · 05.60 10/10 · 05.59 10/10 · 05.58 10/10 · 05.57 10/10 · 05.56 10/10 · 05.55 16/16 · 05.54 12/12

Após o OK de 05.54 e 05.56 o processo Node ainda pode encerrar com `SQLITE_ERROR: no such table: configuracoes` (teardown / conexão residual com o banco oficial). Não é falha das asserções desta sprint.

RISCOS RESTANTES:
- duplicidade de documento Central por chave (não é tabela `compras`)
- classificador histórico CNPJ
- UPDATE devolução só por `id`
- `carregarCompraCabecalho` por `id` interno
- agregação NF-e na lista de compras só por `compra_id`
