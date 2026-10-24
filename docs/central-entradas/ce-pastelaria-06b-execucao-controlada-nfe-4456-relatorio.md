# CE-PASTELARIA-06B — Execução controlada autorizada — NF-e 4456

**Tipo:** execução controlada (autorização humana concedida na conversa)  
**Data/hora da tentativa de pré-voo:** `2026-10-19T02:10:28.047Z` · `18/10/2026, 23:10:28` (America/Fortaleza)  
**Alvo:** empresa **3** · CNPJ `38204469000204` · chave `23261031255007000188550010000044561664976903`  
**Veredito:** **INTERROMPIDO NO PRÉ-VOO — TRANSMISSÃO NÃO EXECUTADA**

---

## 1. Autorização e escopo

| Item | Valor |
|---|---|
| Autorização humana | Concedida nesta conversa |
| Escopo autorizado | **Uma** DistDFe DistNSU via OPERACAO_REAL → `consultar-dfe` |
| Não autorizado | Segunda tentativa · `consChNFe` · 210210 · qualquer outro SOAP |

---

## 2. Pré-voo imediato (somente leitura)

Método: `scripts/ce-pastelaria-06a-prevoo-ro.js` · `OPEN_READONLY` + `PRAGMA query_only` · probe escrita → `SQLITE_READONLY`.  
Banco: `C:\ProgramData\MercantilFiscal\dados\mercadao.db` (Pastelaria; `dados-pastelaria` ausente).  
Sem `database.js`, sem migração, sem mutação.

| # | Verificação | Resultado | Evidência |
|---|---|---|---|
| 1 | Banco Pastelaria + emp.3 = CNPJ | **APROVADA** | emp.3 ativo · `cnpjDigits=38204469000204` · Filial 3 |
| 2 | NSU / cStat / cooldown / FILA | **APROVADA** (leitura) | ult/max **35/35** · cStat **656** · cooldown_ate abaixo |
| 3 | Cooldown 656 encerrado? | **BLOQUEADA** | ainda ativo |
| 4 | Certificado + ambiente + OPERACAO_REAL | **APROVADA** | PFX existe · status **VÁLIDO** até 2027-02-27 · ambiente **1** · OPERACAO_REAL ativa + seed |
| 5 | Lock concorrente | **APROVADA** (livre) | `%TEMP%\cds-sefaz-locks` sem `.lock` |
| 6 | BACKGROUND / sync ao abrir | **APROVADA** (código fail-closed) | flags sync=`true`, mas decisão exige auth; cooldown também bloqueia |
| 7 | Decisão centralizada | **NÃO EXECUTADA COM TRANSMISSÃO** | pré-voo parou por cooldown; decisão seria `COOLDOWN_ATIVO` (snapshot CE-06A) |

### Estado NSU na coleta

| Campo | Valor |
|---|---|
| ultNSU / maxNSU | `000000000000035` / `000000000000035` |
| ultimo_cstat | **656** |
| cooldown_ate | **`2026-10-19T02:23:31.759Z`** |
| Liberação Fortaleza | **`18/10/2026, 23:23:31`** |
| Agora (pré-voo) | `18/10/2026, 23:10:28` |
| Restante | **~14 minutos** (`restanteMs ≈ 783712`) |
| Sticky FILA estrutural | Sim (ult=max + 656) — prevalece **após** o cooldown, sem liberação admin |

---

## 3. Liberação local da FILA

| Status | **NÃO EXECUTADA** |
|---|---|
| Motivo | Cooldown explícito ainda ativo — liberação admin **não** contorna cooldown 656 e a sprint exige parar sem alterar estado |
| Evento `FILA_ESGOTADA_LIBERACAO_OP` | Não gerado |
| NSU | Preservado (não tocado) |
| SOAP | Nenhum |

---

## 4. Consulta DistDFe real

| Status | **NÃO EXECUTADA** |
|---|---|
| Motivo | Condição obrigatória §2.3 / §5: *cooldown ativo → NÃO transmitir* |
| correlationId | — |
| cStat / documentos / persistência | — |
| Chave 4456 | Continua **ausente** localmente (0 docs na coleta RO) |

---

## 5. Condição de parada acionada

**Cooldown explícito pós-656 ainda vigente.**

Horário exato de liberação do cooldown (persistido):

- UTC: `2026-10-19T02:23:31.759Z`
- Fortaleza: `18/10/2026, 23:23:31`

Nenhuma alteração de NSU, FILA, flags, certificado ou autorização foi feita nesta execução.

---

## 6. Próximos passos (somente após nova autorização humana)

1. Aguardar **após** `23:23:31` Fortaleza (`02:23:31Z`).  
2. Novo pré-voo RO: se FILA sticky (`FILA_ESGOTADA`), liberar FILA **local** (admin) e exigir evento `FILA_ESGOTADA_LIBERACAO_OP`.  
3. Com autorização explícita, **uma** DistDFe via OPERACAO_REAL → `consultar-dfe`.  
4. Parar em 656 / 137 / erro; sem retry; sem `consChNFe` nesta autorização.

---

## 7. Confirmações finais

| Item | Status |
|---|---|
| DistDFe / SOAP | **Não executado** |
| Liberação FILA | **Não executada** |
| consChNFe / 210210 | **Não executados** |
| Banco oficial alterado | **Não** |
| Segunda tentativa | **Não** |
| Commit / push / merge / reset | **Não** |

**Execução encerrada no pré-voo por cooldown ativo.**
