# Implementação 04.09 — Gestão da configuração fiscal multiempresa

**Status:** concluída · **Não inclui:** UI, upload visual, impressão, 04.10

## Auditoria

| Dado | Onde estava | Emissor usa? |
|---|---|---|
| CNPJ / razão / IE | `empresas` + global `configuracoes` | sim (emitente) |
| CSC / id CSC | `configuracoes.fiscal_token_csc` / `fiscal_id_csc` | sim (QR) |
| Certificado | path+senha em `configuracoes`; arquivo em pasta fiscal `certificados/certificado.pfx` via `rotas/fiscal.js` | `carregarCertificadoPfx` |
| Ambiente / série / número | `configuracoes` + MAX `nfce_notas` | sim |
| URLs SEFAZ | `configuracoes` | sim (`validarUrls`) |

04.08 já criou `empresas_configuracao_fiscal` e resolução por `empresaId`. **Lacuna real:** sem API admin, sem persistência parcial/merge, sem status, GET exporia row cru se alguém lesse o banco via serviço interno.

Não existe RBAC fiscal dedicado. Rotas de empresas já usam `verificarToken` em `server.js`.

## Certificado

Reutilizado o mecanismo oficial: **caminho + senha** (igual ao global). Sem `CertificadoMultiempresaService`. Upload legado `/api/fiscal/certificado/upload` continua gravando o PFX global. MULTIEMPRESA aponta `certificado_path` por empresa para o arquivo desejado.

## Serviço (mesmo módulo 04.08)

- `obterConfiguracaoFiscalEmpresa` — DTO público (sem segredos)
- `salvarConfiguracaoFiscalEmpresa` — merge + parcial + TX
- `validarConfiguracaoFiscalEmpresa` — só estrutura (ambiente 1|2, série ≥ 1)
- `removerConfiguracaoFiscalEmpresa`
- `obterStatusFiscalEmpresa` / `listarStatusFiscalEmpresas`
- `exigirEmpresaAlvoAdministrativo` — rota ≠ body → `EMPRESA_CONFIGURACAO_DIVERGENTE`

Emissão continua em `getFiscalConfig({ empresaId })` / emissor. Sem config → `CONFIGURACAO_FISCAL_EMPRESA_AUSENTE` (sem global).

## Status administrativo

`PRONTA` | `INCOMPLETA` | `INVALIDA` | `DESATIVADA`

PRONTA exige ambiente, série, CSC (token+id), certificado (path+senha) e URL de autorização. Não verifica existência do PFX no disco (isso é do emissor).

## Rotas (`/api/empresas`, token existente)

- `GET /configuracao-fiscal/status`
- `GET|PUT|DELETE /:empresaId/configuracao-fiscal`

Autoridade: `req.params.empresaId`.

## MUV

Não conhece CSC, senha nem PFX.

## EMPRESA_UNICA

`getFiscalConfig()` sem `empresaId` permanece `fonte: 'GLOBAL'`. Config global não foi removida.
