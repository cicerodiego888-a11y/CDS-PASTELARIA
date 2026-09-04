# SPRINT 05.67

STATUS: CONCLUÍDA

PRODUÇÃO ALTERADA: SIM — somente validação de chave no POST `/api/compras`

WRITER ALTERADO: NÃO (INSERT inalterado; só a consulta de duplicidade)

FUNÇÃO DE DUPLICIDADE: SQL inline em `iniciarGravacaoComEmpresa` (`backend/rotas/compras.js`). Não usa `existeCompraComChave`.

CHAMADORES:
- POST `/api/compras` (alterado)
- `CentralDfePersistenciaService.existeCompraComChave` (não alterado)

CONSULTA ANTERIOR:
`SELECT id, status FROM compras WHERE chave_acesso = ? LIMIT 1` (antes de resolver empresa)

CONSULTA NOVA:
após `resolverEmpresaDaCompra`:
`SELECT id, status FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1`
params: `[chaveLimpa, empresaIdOperacao]` (`resolvida.empresaId`)

EMPRESA A + CHAVE X: duplicidade na própria empresa (mensagem com `#id` preservada)

EMPRESA B + CHAVE X: não encontra A; INSERT permitido; A+X e B+X coexistem

NULL: chave + `empresa_id` NULL não é dono de A

CROSS-COMPANY: PASSOU

TESTES: 8/8 (`tests/compras/isolamento-chave-empresa-05-67.test.js`)

REGRESSÕES (2026-08-29):
05.67 8/8 · 05.66 8/8 · 05.65 10/10 · 05.64 8/8 · 05.63 10/10 · 05.62 8/8 · 05.61 8/8 · 05.60 10/10 · 05.59 10/10 · 05.58 10/10 · 05.57 10/10 · 05.56 10/10 · 05.55 16/16 · 05.54 12/12

RISCOS RESTANTES:
- `existeCompraComChave` na Central ainda global
- classificador histórico CNPJ
- UPDATE devolução só por `id`
