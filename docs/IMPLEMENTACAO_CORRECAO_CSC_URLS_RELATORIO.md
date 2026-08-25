# Relatório — Correção CSC + URLs fiscais

**STATUS:** ESTADO B  
**Classificação:** correção pontual / manutenção  
**Data:** 2026-08-24

---

## 1. Causa real encontrada

Não havia coluna/chave ausente. `id_csc` e `token_csc` já existem em `empresas_configuracao_fiscal` (e no legado `configuracoes.fiscal_id_csc` / `fiscal_token_csc`).

Causas combinadas:

| # | Causa | Efeito |
|---|--------|--------|
| **F** | GET admin (`dtoPublicoConfiguracao`) **não devolvia `id_csc`** — só `id_csc_configurado` / `csc_configurado` | Após reload, ID CSC aparecia vazio com placeholder “CONFIGURADO…”, parecendo não persistido |
| **F** | Inputs `gef-id-csc` / `gef-csc` eram `type=password` **sem value** | Usuário não via o ID salvo; só o placeholder |
| **C/G** | PUT global `/api/fiscal/config` gravava **todos** os campos com `String(valor ?? '')` | Token/ID vazios (ou placeholder) **apagavam** o valor real ao salvar outros campos |
| URLs | Campos vazios na config por empresa **não eram preenchidos** a partir do catálogo oficial (`RegistryBuilder.ENDPOINTS`) | Tela exibia URLs em branco mesmo com UF/ambiente conhecidos |

Persistência por empresa no merge parcial **já preservava** CSC quando o campo não vinha no patch; o problema de UX/leitura e o wipe no PUT global eram os principais.

---

## 2. Fluxo anterior

```
Tela gestão empresas → PUT /api/empresas/:id/configuracao-fiscal
  → token_csc / id_csc gravados em empresas_configuracao_fiscal
  → GET devolve só flags (sem id_csc)
  → UI password vazia + “CONFIGURADO…”

Tela Centro Configurações → PUT /api/fiscal/config
  → envia fiscal_token_csc="" ao salvar outros campos
  → sobrescreve token no banco com string vazia
```

---

## 3. Fluxo corrigido

```
TELA
  ID CSC (texto, valor real se existir)
  TOKEN (password vazio + placeholder se configurado)
    ↓
montarPayloadFiscal / coletarPayloadFiscal
  (omite vazio e placeholder)
    ↓
API (empresa ou global filtrado)
    ↓
sanitizarPatchCsc / filtrarPayloadConfigFiscalUi
    ↓
empresas_configuracao_fiscal | configuracoes
    ↓
GET público: id_csc real + csc_configurado (sem token)
    ↓
URLs vazias preenchidas via FiscalConfigUrlsResolver (RegistryBuilder)
```

---

## 4. Origem oficial do ID CSC

- **Multiempresa / por empresa:** `empresas_configuracao_fiscal.id_csc`
- **Legado global:** `configuracoes.chave = fiscal_id_csc`
- Motor de emissão: `config.idCSC` via `getFiscalConfig` / `montarConfigEmpresa`

---

## 5. Origem oficial do TOKEN CSC

- **Por empresa:** `empresas_configuracao_fiscal.token_csc`
- **Legado global:** `configuracoes.chave = fiscal_token_csc`
- Motor: `config.tokenCSC` (interno; **não** no DTO de UI)

---

## 6. Como as URLs são resolvidas

Helper fino (não é motor novo):

`backend/services/fiscal/FiscalConfigUrlsResolver.js`

- Reutiliza `ENDPOINTS` de `RegistryBuilder` (SVRS NFC-e).
- Consulta pública QR/chave: mesmas bases do seed (`nfce.sefaz.ce.gov.br` / `nfceh.sefaz.ce.gov.br`).
- **Só preenche campo vazio**; URL manual existente **não** é sobrescrita.
- GET admin enriquece blocos de exibição se persistido estiver vazio.
- Campos da tela (já existentes): autorização, retorno, status, consulta QR, consulta chave — homologação e produção.

Não foram inventados endpoints novos nem colunas novas de URL.

---

## 7. Arquivos alterados / criados

**Criados**

- `backend/services/fiscal/FiscalConfigUrlsResolver.js`
- `tests/configuracao-fiscal-csc-urls-correcao.test.js`
- `docs/IMPLEMENTACAO_CORRECAO_CSC_URLS_RELATORIO.md`

**Alterados**

- `backend/services/fiscal/empresasConfiguracaoFiscal.js` — DTO com `id_csc`; sanitize CSC; URLs oficiais se vazias
- `backend/services/fiscal/configService.js` — DTO UI, filtro PUT, completar URLs globais, log sem token
- `backend/rotas/fiscal.js` — GET mascarado; PUT preserva segredos
- `frontend/erp/js/gestao-empresas-fiscal.js` — ID visível; token mascarado; payload sem placeholder
- `frontend/erp/js/fiscal.js` — token mascarado; payload sem wipe
- Testes ajustados: `gestao-fiscal-visual-05-15`, `validacao-operacional-multiempresa-05-18-4`

---

## 8. Migrations

Nenhuma. Colunas `id_csc` / `token_csc` e chaves `fiscal_*` já existiam.

---

## 9. Testes novos

`tests/configuracao-fiscal-csc-urls-correcao.test.js` → **13/13 PASS**

Cobertura: salvar ID/token, máscara GET, preservar ao editar outro campo, substituir, placeholder, isolar A/B, URLs prod/homolog, manual preservada, mudança de ambiente, PUT global.

---

## 10. Regressões executadas

| Suite | Resultado |
|-------|-----------|
| gestao-fiscal-visual-05-15 | 18/18 |
| isolamento-fiscal-multiempresa-05-18 | 3/3 |
| urls-fiscais-05-18-2 | 8/8 |
| validacao-operacional-multiempresa-05-18-4 | OK |
| configuracao-fiscal-multiempresa-04-09 | 26/26 |
| fiscal-qrcode | 9/9 |

---

## Comportamentos garantidos

- Alterar só ID CSC **não** apaga TOKEN.
- Campo vazio / placeholder **não** sobrescreve TOKEN/ID.
- TOKEN **não** retorna no GET de UI; ID CSC **sim**.
- URLs oficiais SVRS/CE preenchidas quando vazias; manuais preservadas.
- Motor Fiscal / emissão / TEF / PDV / Compras **não** alterados em regra de negócio.
