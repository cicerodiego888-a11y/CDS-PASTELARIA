# Auditoria — Ativação explícita de MULTIEMPRESA na Central (Sprint 03.06.1)

TIPO: AUDITORIA + correção pontual de persistência/UI  
PRODUÇÃO ALTERADA: SIM — `saveConfig()` oficial com `confirmacao_modo_operacional: true`; UI exporta `salvarConfiguracoesAvancadas` e lê o rádio via `querySelector`.  
Contrato 05.54: **não alterado**. Sem `empresas.length > 1 → MULTIEMPRESA`.

---

## 1. Sintoma

Instalação com **3 empresas ativas**. A Central resolvia **EMPRESA_SIMPLES** e exigia `empresa_operacional_id`, com `EMPRESA_OPERACIONAL_AMBIGUA` / *Modo EMPRESA_SIMPLES com múltiplas empresas ativas...*.

## 2–4. Configuração encontrada (antes da correção)

Fonte oficial de runtime (não o `config/configuracoes.json` do repositório):

`C:\ProgramData\MercantilFiscal\dados\config\configuracoes.json`

| Campo | Persistido (antes) | Consumido pelo runtime |
|-------|---------------------|------------------------|
| `modo_operacional_global` | `EMPRESA_SIMPLES` | `EMPRESA_SIMPLES` |
| `modo_operacao_venda` | `EMPRESA_UNICA` | derivado = `EMPRESA_UNICA` |
| `empresa_operacional_id` | vazio / null | null |

Cópia no repositório `config/configuracoes.json`: **não** contém `modo_operacional_global` (legado; só migrado se o arquivo oficial **não existir**).

Empresas ativas no banco oficial (`mercadao.db`): 3 (ids 1, 2, 3 — CNPJs da Pastelaria).

UI: rádios existem; valor mostrado segue o GET (`readConfig()`), portanto também **EMPRESA_SIMPLES**. Não havia divergência UI vs persistido no arquivo oficial.

## 5. Cadeia de resolução

| Etapa | Arquivo | Função | Entrada | Saída | Fonte | Risco |
|-------|---------|--------|---------|-------|-------|-------|
| UI | `cds-centro-configuracoes.js` | rádios + `#cfgModoOperacionalAnterior` | GET config | rádio marcado | `modo_operacional_global` do GET | G: botão Salvar dependia de `window.salvarConfiguracoesAvancadas` sem atribuição explícita; leitura jQuery do rádio |
| POST | `rotas/configuracoes_avancadas.js` | `POST /` | body | `saveConfig(data)` | `req.body` | A — MULTIEMPRESA aceito se `validarModoOperacionalGlobal` |
| save | `configuracaoService.js` | `saveConfig` | obj + confirmação | JSON oficial | `getConfigPath()` = `DB_DIR/config/configuracoes.json` | A se confirmação omitida (409, não grava) |
| JSON | ProgramData `configuracoes.json` | — | — | chaves globais | mesmo path de leitura | C cópia legado no repo **não** é lida se o oficial existe |
| obter | `obterModoOperacionalGlobal()` | arquivo | `lerModoOperacionalGlobalPersistido` | A |
| resolver | `resolverModoOperacionalGlobalAtivo()` | deps ou arquivo | modo validado | A — não ignora persistido |
| Contrato | `ContratoOperacionalService` | modo do resolver | MULTI → `empresa_operacional = null` | A |
| Central | `listarAlvosSincronizacaoCentral` | contrato | SIMPLES → 1 alvo ou AMBIGUA; MULTI → ativas | A |

Callers da Central (`CentralSincronizacaoService`, Orchestrator, `CentralSyncExecucaoService`) **não** forçam EMPRESA_SIMPLES. `this._deps.configuracaoService` é o serviço **fiscal** da Central (`CentralConfiguracaoService`), sem `obterModoOperacionalGlobal`. O sanitizer do modo só aceita `configService` / `obterModoOperacionalGlobal`; portanto o modo vem do JSON oficial.

## 6. Causa encontrada

**A — MULTIEMPRESA nunca foi salvo no arquivo oficial.**

Não é B (leitura errada): runtime lia `EMPRESA_SIMPLES` igual ao JSON.  
Não é E: `resolverModoOperacionalGlobalAtivo()` não descarta o persistido.  
Não é F: Central não injeta EMPRESA_SIMPLES.  
Não é G: o processo usa `getDbDir()` → ProgramData (não o JSON do repo).

D (init) só escreve default se a chave **não existir**; aqui a chave existia como `EMPRESA_SIMPLES`.

Causa operacional complementar (persistência pela UI): `salvarConfiguracoesAvancadas` não era exportada em `window`; o clique em Salvar podia ser no-op; a leitura do rádio usava jQuery em vez do mesmo `querySelector` do centro.

## 7–8. Correção

1. `window.salvarConfiguracoesAvancadas` / `loadConfiguracoesAvancadas`.  
2. Rádio via `document.querySelector`.  
3. Aviso se a função de save não existir.  
4. Ativação da instalação: `saveConfig({ ...current, modo_operacional_global: 'MULTIEMPRESA', confirmacao_modo_operacional: true })` — **explícito**, sem `empresas.length`.

Arquivos: `frontend/erp/js/configuracoes.js`, `frontend/erp/js/cds-centro-configuracoes.js`, JSON oficial via `saveConfig`.

Não alterados: DistDFe, NSU, MIIP, compras, schema, fila 05.74, 05.70, 05.55, saúde, 05.76.

## 9–10. Antes / depois

Antes: persistido e runtime `EMPRESA_SIMPLES` → contrato tenta empresa operacional → N>1 sem id → `EMPRESA_OPERACIONAL_AMBIGUA`.

Depois: persistido e runtime `MULTIEMPRESA` → `empresa_operacional = null` → alvos = empresas ativas.

Evidência pós-`saveConfig` (instalação):

- JSON: `modo_operacional_global = MULTIEMPRESA`, `modo_operacao_venda = MULTIEMPRESA`
- `obterModoOperacionalGlobal()` = MULTIEMPRESA
- `resolverModoOperacionalGlobalAtivo()` = MULTIEMPRESA
- contrato: MULTIEMPRESA, `empresa_operacional = null`
- alvos: 3 — ids 1, 2, 3 (CNPJs 38204469000115 / 38204469000387 / 38204469000204)

## 11. Empresas A/B/C (contrato de teste)

Testes usam ids 11 / 22 / 33 (CNPJs da 05.54). A instalação real tem ids 1 / 2 / 3.

## 12–14. Testes, regressões, riscos

Ver relatório `docs/IMPLEMENTACAO_03_06_1_RELATORIO.md`.

Riscos: SUPER_ADMIN ainda precisa confirmar na UI em próximas alterações; `empresa_operacional_id` residual pode permanecer e **não** decide alvos em MULTIEMPRESA; certificado/SEFAZ por CNPJ continua independente (fora desta sprint).
