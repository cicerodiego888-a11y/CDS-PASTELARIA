# Pacote de auditoria — Sprint 07 · S07-2

**Gerado para:** Tech Lead  
**Modo:** somente leitura / cópias — sem alteração de código de produção, sem migração, sem reinício.

## Conteúdo integral (cópias)

| Arquivo no pacote | Origem |
|-------------------|--------|
| `CozinhaSessaoUnidadeService.js` | `backend/services/cozinha/CozinhaSessaoUnidadeService.js` |
| `cozinha.js` | `backend/rotas/cozinha.js` (arquivo completo; rotas S07-2 ~L176–220) |
| `cozinha-kds.js` | `frontend/erp/js/cozinha-kds.js` |
| `cozinha-kds.css` | `frontend/css/cozinha-kds.css` |
| `middleware-auth.js` | `backend/middleware/auth.js` |
| `auth.js-finalizarLoginComUsuario-excerpt.js` | trecho de `backend/rotas/auth.js` (emissão oficial JWT no login) |
| `sprint07-s07-2-sessao-unidade-kds.test.js` | testes S07-2 |
| `sprint07-s07-1-painel-kds-ui.test.js` | regressão UI S07-1 |
| `RELATORIO-SPRINT07-S07-2.md` | relatório |
| `LOG-SPRINT07-S07-2.txt` | log (pode estar UTF-16 no original; ver encoding) |
| `DIFF-SPRINT07-S07-2.patch` | diff completo (`git diff --no-index NUL <arquivo>`) |

## Observação git

Arquivos da Cozinha S07-* estão **untracked** (`??`). O patch foi gerado com `git diff --no-index`.  
`auth.js` / `middleware/auth.js` **não** foram alterados pela S07-2; incluídos como referência da emissão/validação oficial do JWT.

## Pontos de auditoria priorizados

1. Autorização de unidade: `listarUnidadesDisponiveis` + `validarUnidadeCozinhaNoLogin` em `selecionarUnidadeSessao`
2. Reemissão JWT: `emitirJwtComUnidade` + `JWT_SECRET` de `middleware/auth.js`
3. Whitelist de claims: `montarClaimsSessao`
4. Expiração: preserva `exp` absoluto; fallback `expiresIn: '8h'`
5. Frontend/Electron: `persistirSessao` (`localStorage` + `electronAPI.cozinhaImpressao.estabelecerSessao`)
