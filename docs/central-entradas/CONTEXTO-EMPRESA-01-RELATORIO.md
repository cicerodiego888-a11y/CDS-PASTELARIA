# CONTEXTO-EMPRESA-01 — Auditoria e consolidação do contexto de empresa

Escopo: Central de Monitoramento, Centro de Configurações (painel executivo) e Central de Entradas.
Sem chamada SEFAZ, sem sincronização, sem alteração de configuração fiscal.

## 1. Fontes de configuração encontradas

| Informação | Fontes encontradas |
|---|---|
| Empresa atual | `X-Empresa-Id` / `req.empresaId` (seletor global `CdsEmpresaContexto`, localStorage); contrato `ContratoOperacionalService` (EMPRESA_SIMPLES: `empresa_operacional_id` ou empresa ativa única); `resolverEmpresaParaCentral` (Central) |
| Empresa matriz | **não existia** — o frontend escolhia `disponiveis[0]` (ordem alfabética) em `cds-empresa-contexto.js` e `central-entradas.js` |
| CNPJ | `empresas.cnpj`; `configuracoes.cnpj` (global, via `GET /fiscal/config`) |
| Ambiente fiscal | `empresas_configuracao_fiscal.ambiente`; `configuracoes.fiscal_ambiente` (lido cru por `IndicadoresFiscaisService.obterAmbienteConfigurado`); `ambiente: 2 'Homologação'` fixo no fallback do `FiscalProvider` |
| Certificado | `empresas_configuracao_fiscal.certificado_path`; `configuracoes.fiscal_certificado_path` (global) |
| Endpoint SEFAZ | UrlResolver/RegistryBuilder a partir do ambiente do contexto (inalterado) |
| Competência | parâmetros `ano/mes` → `resolverCompetencia` (padrão: mês corrente) |
| Configuração Central | `central_entradas_config` (timeouts, sync, política — sem identidade fiscal) |
| NSU | `central_entradas_nsu` por CNPJ + ambiente da empresa (CE-06) |
| Gate | `CentralSefazOperationalGate` — 593/fingerprint por empresa (CE-06) |

## 2. Duplicidades / divergências confirmadas

1. **Painel executivo (Centro de Configurações)**: empresa/CNPJ/ambiente vinham de `GET /fiscal/config` (global) e SEFAZ/certificado de `/central-entradas/configuracao` **sem `X-Empresa-Id`** → "Empresa não selecionada" ao lado de empresa global. Caso "Empresa A → CNPJ correto / SEFAZ → empresa nula".
2. **Monitoramento**: ambiente lido de `configuracoes.fiscal_ambiente`, ignorando a empresa. Caso "Empresa A → Produção / Dashboard → Homologação".
3. **Bug pré-existente** em `IndicadoresFiscaisService.obterQuantidadeNfeEmitidas`: usava `dbGet` inexistente → `ReferenceError` → `obterResumo` sempre falhava → `FiscalProvider` caía no fallback **fixo "Homologação"**. O Monitoramento exibia Homologação independentemente de qualquer configuração.
4. **Indicadores da Central** (`obterIndicadoresCentral` com `empresaId`): ambiente global em vez do da empresa.
5. **Empresa padrão**: primeira em ordem alfabética (podia ser filial), não a matriz.
6. Competência e ambiente no mesmo cabeçalho do Monitoramento.

## 3. Fonte oficial definida

`resolverContextoEmpresaOperacional()` em `backend/services/empresas/ContextoEmpresaOperacionalService.js` — reutiliza fontes existentes, nenhuma configuração nova:

- empresa/CNPJ → `empresas`
- ambiente/UF/certificado → `empresas_configuracao_fiscal` via `getFiscalConfig({ empresaId })`
- matriz → CNPJ com ordem `0001` (regra legal); desempate por `empresa_operacional_id` já existente
- `configuracoes.*` global: somente EMPRESA_SIMPLES sem config própria, **declarado** em `origemAmbiente = 'configuracoes (legado EMPRESA_SIMPLES)'`; nunca no MULTIEMPRESA

Retorno: `{ empresaId, razaoSocial, cnpj, tipoEmpresa, ambienteFiscal, uf, certificado, contextoResolvido, estado, origens }` (certificado sem senha e sem caminho completo; PFX nunca aberto).

## 4. Arquivos alterados

- **novo** `backend/services/empresas/ContextoEmpresaOperacionalService.js`
- `backend/monitoring/MonitoringController.js` — contexto no summary; `GET /api/monitoring/contexto-empresa` (diagnóstico)
- `backend/monitoring/MonitoringRouter.js`, `backend/monitoring/MonitoringEngine.js` — rota; `contextoEmpresa` no payload/cache key
- `backend/monitoring/providers/FiscalProvider.js` — ambiente do contexto; fallback sem "Homologação" fixo
- `backend/services/IndicadoresFiscaisService.js` — `ambienteContexto`, `obterAmbienteFiscalComOrigem`, correção do `dbGet`
- `backend/motores/central-entradas/controllers/CentralConfiguracaoController.js` — painel abre na matriz sem seleção; ações continuam exigindo empresa explícita
- `backend/rotas/empresas.js` — `/contexto/disponiveis` marca `tipo_empresa` e `matriz_padrao`
- `frontend/erp/js/cds-centro-configuracoes.js` — painel executivo com `X-Empresa-Id` e contexto único; card SEFAZ = razão social + CNPJ + ambiente
- `frontend/erp/js/cds-monitoring-engine.js` — card "Contexto fiscal" (empresa/CNPJ/SEFAZ/certificado) separado da competência; `X-Empresa-Id`; recarrega ao trocar empresa
- `frontend/shared/js/cds-empresa-contexto.js`, `frontend/erp/js/central-entradas.js` — seleção padrão = matriz
- **novo** `tests/central-entradas/contexto-empresa-operacional.test.js`; `package.json` (`test:contexto-empresa`)

## 5. Fluxo final

```
seleção explícita (X-Empresa-Id)? ── sim ─► empresa selecionada (inválida → CONTEXTO_EMPRESA_INVALIDO)
            │ não
MULTIEMPRESA ─► matriz CNPJ 0001 única ─► / várias → empresa_operacional_id ─► / ativa única ─► / senão EMPRESA_NAO_SELECIONADA
EMPRESA_SIMPLES ─► empresa do contrato operacional
            ▼
empresas_configuracao_fiscal (ambiente, UF, certificado)
   ausente → MULTI: FISCAL_NAO_CONFIGURADO | SIMPLES: global declarado como legado
            ▼
Monitoramento · Painel executivo · Painel Central (mesmo objeto + origens)
```

## 6–7. Testes

| Suíte | Resultado |
|---|---|
| `contexto-empresa-operacional` (A–I + segurança) | **33 PASS / 0 FAIL** |
| CE-03 período / XML | 12 / 17 PASS |
| CE-04 gate | 21 PASS |
| CE-05 segurança | 28 PASS |
| CE-06 multicnpj | 42 PASS |
| Regressão `tests/central-entradas` (82 suítes) | 53 PASS / 29 FAIL — as mesmas 29 da baseline CE-06, linhas de falha e contagens idênticas |
| Monitoring m1–m4, rc832, hotfix-consumo-exclusivo-motor | falham **identicamente no HEAD** (tabelas ausentes em DB vazio / textos de UI) — pré-existentes |
| usuario-empresa-03-3, caixa-05-45, estoque, mis, muv, rc800 | PASS |

Nenhum log referencia `MercantilFiscal\dados\mercadao.db`; todas as suítes com `DB_DIR` temporário.

## 8. Confirmações

- Sem chamada real à SEFAZ (barreira SOAP: 0 chamadas).
- Sem alteração de CNPJ.
- Sem alteração de certificado (nenhum PFX aberto: barreira 0).
- Sem alteração de NSU.
- Sem alteração de ambiente fiscal (`configuracoes.fiscal_ambiente` e `empresas_configuracao_fiscal` apenas lidos).
- Sem alteração das regras CE-04/05/06 (Gate, manifestação, diagnóstico por empresa inalterados; suítes 100% PASS).
