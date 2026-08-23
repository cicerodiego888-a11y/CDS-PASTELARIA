# AUDITORIA — CONFIGURAÇÃO FISCAL GLOBAL (Sprint 05.18)

Classificação: **LEGADO** | **COMPATIBILIDADE** | **MULTIEMPRESA** | **PENDENTE DE MIGRAÇÃO**

## Fonte global

Tabela `configuracoes` (chaves `fiscal_*`, `cnpj`, certificado global).

`getFiscalConfig({ empresaId })`:

- com `empresaId` válido → `empresas_configuracao_fiscal` (**MULTIEMPRESA**)
- sem `empresaId` → mapa `configuracoes` (**LEGADO / COMPATIBILIDADE**)

## Plataforma Fiscal (UI)

Arquivo: `frontend/erp/js/fiscal.js`

| Campo / ação | Destino | Classe |
|---|---|---|
| Ambiente, UF, série, numeração | `PUT /api/fiscal/config` → `configuracoes` | LEGADO |
| ID CSC / Token CSC | `fiscal_token_csc` no perfil global | LEGADO |
| Upload .PFX sem `empresa_id` | `certificado.pfx` + config global | LEGADO |
| Senha certificado | perfil global | LEGADO |

Centro de Configurações já avisa: CSC/certificado **por empresa** ficam em Empresas. A plataforma permanece para perfil global.

## Upload certificado (backend/rotas/fiscal.js)

| Condição | Comportamento | Classe |
|---|---|---|
| `empresa_id` no body | `certificado-empresa-{id}.pfx` + `salvarConfiguracaoFiscalEmpresa` | MULTIEMPRESA |
| sem `empresa_id` | `certificado.pfx` global | COMPATIBILIDADE (Plataforma Fiscal) |

A tela Empresas **sempre** envia `empresa_id` da edição. Não usa contexto operacional nem empresa 1.

## `getFiscalConfig()` sem empresa

| Arquivo | Uso | Classe |
|---|---|---|
| `configService.js` | implementação | — |
| `emissor.js` NFC-e | `getFiscalConfig(fiscalOpts)` quando há empresa | MULTIEMPRESA |
| `emissor.js` outro trecho | `getFiscalConfig()` sem id | PENDENTE DE MIGRAÇÃO / COMPATIBILIDADE EMPRESA_UNICA |
| `nfeEmissorVenda.js` | `getFiscalConfig()` | PENDENTE DE MIGRAÇÃO |
| `nfeDevolucaoVenda.js` / Lifecycle | `getFiscalConfig()` | PENDENTE DE MIGRAÇÃO |
| `nfeDevolucaoCompra.js` / Lifecycle | `getFiscalConfig()` | PENDENTE DE MIGRAÇÃO |
| `nfeCentralService.js` | `getFiscalConfig()` | PENDENTE DE MIGRAÇÃO |
| `distribuicaoDFe.js` | `getFiscalConfig({ validarUrls: false })` | PENDENTE DE MIGRAÇÃO |
| `nfeOperacionalService.js` | idem | PENDENTE DE MIGRAÇÃO |
| `cancelarNfe.js` / `cancelarNfce.js` | `getFiscalConfig()` | PENDENTE DE MIGRAÇÃO |

Regra vigente: em MULTIEMPRESA a emissão NFC-e do PDV/MUV deve passar `empresaId` em `fiscalOpts`. Não substituir silenciosamente a config da empresa pela global **quando o `empresaId` está presente**.

Esta sprint **não** reescreve o motor fiscal nem esses callers. Só documenta.

## Modo MULTIEMPRESA na gestão

A tela Empresas lê/grava somente `/api/empresas/:id/configuracao-fiscal`. Não chama `GET /api/fiscal/config` para preencher a empresa em edição.
