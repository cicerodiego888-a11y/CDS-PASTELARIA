# Microsprint P0.12 — Primeira consulta real DistDFe

**Autorização do responsável:** CONCEDIDA  
**Ambiente:** produção SEFAZ  
**Escopo executado:** uma única DistDFe · uma única empresa  
**Veredito:** **APROVADO COM RESSALVAS**

---

## 1. Horário e fuso

| Item | Valor |
|---|---|
| Início (UTC) | `2026-10-18T23:39:58.385Z` |
| Início (local) | `18/10/2026, 20:39:58` |
| Fim (UTC) | `2026-10-18T23:40:01.834Z` |
| Fim (local) | `18/10/2026, 20:40:01` |
| Fuso | **America/Fortaleza** |
| Duração total | ~3,4 s (SOAP ~1,4 s) |
| CorrelationId | `5d84d0c5-5544-4785-b1f9-0cd54db68d0d` |

---

## 2. Empresa selecionada

| Campo | Valor |
|---|---|
| `empresaId` | **1** |
| Identificação | CIC… |
| CNPJ | `**.***.***/****-15` |
| Ambiente | **1 (produção)** |
| OPERACAO_REAL | ativa (`temTokenSeed` confirmado no pré-voo RO) |

**Critério de escolha:** das três empresas ativas com cooldown NSU já expirado na coleta RO (~20:37), a empresa 1 tinha o cooldown liberado há mais tempo (desde ~20:17) e estado operacional mais claro.

Empresas 2 e 3 **não** foram consultadas.

---

## 3. Evidências do pré-voo (antes do SOAP)

### 3.1 Coleta RO (sem `database.js`)

- Banco: `C:\ProgramData\MercantilFiscal\dados\mercadao.db`
- Método: `sqlite3.OPEN_READONLY` + `PRAGMA query_only` (probe UPDATE → `SQLITE_READONLY`)
- Cooldown NSU produção: **inativo** para empresas 1, 2 e 3 na coleta 20:37
- `recuperacao_xml_ativa` KV=`true` porém motor efetivo **não** autoriza SOAP (legado P0.8/P0.11)
- Nenhum processo CDS/Electron ouvindo API no momento da operação

### 3.2 Decisão centralizada (P0.11)

`CentralConsultaDistDfeDecisaoService.diagnosticarEmpresa` → **`PRONTO_PARA_CONSULTA`**  
(`cooldownAtivo=false`, mutex livre)

### 3.3 Pré-voo OPERACAO_REAL (com `FISCAL_DIR` de produção)

| Item | Resultado |
|---|---|
| Empresa / CNPJ / ambiente produção | OK |
| Certificado A1 apto | OK |
| NSU / decisão | OK (`ultNSU=196`) |
| Endpoint DistDFe no pré-voo | `ENDPOINT_PENDENTE` (resolvido no envio SOAP) |
| Bloqueios | nenhum |

Fluxo usado: `CentralEntradasOrchestrator.consultarDfeReal` → autorização `OPERACAO_REAL` (não teste).

**Tentativa anterior abortada sem SOAP:** na primeira execução do script, sem `FISCAL_DIR=…\ProgramData\…\fiscal`, o gate de certificado retornou `CERTIFICADO_CAMINHO_NEGADO`. Nenhuma chamada SEFAZ foi feita nessa tentativa. Correção: espelhar o Electron (`DB_DIR` + `FISCAL_DIR` em ProgramData) e repetir **uma** execução autorizada.

---

## 4. NSU inicial (registrado, não modificado manualmente)

| Campo | Valor |
|---|---|
| `ult_nsu` | `000000000000196` |
| `max_nsu` | `000000000000196` |
| `ultimo_cstat` (antes) | `656` |
| `cooldown_ate` (antes) | `2026-10-18T23:17:04.375Z` (já expirado) |

---

## 5. Confirmação de uma única chamada SOAP

| Evidência | Valor |
|---|---|
| Origem | `CONSULTA_DFE_REAL` |
| Endpoint | `https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx` |
| HTTP | **200** |
| Tempo SOAP | **1403 ms** |
| `consultaExecutada` | **true** |
| Iterações DistDFe adicionais | 0 |
| `consChNFe` / 210210 / cancelamento | **não executados** |
| Outras empresas | **não consultadas** |
| Retry automático pós-656 | **não** |

---

## 6. cStat e resultado

| Campo | Valor |
|---|---|
| cStat | **656** |
| xMotivo (sanitizado) | Rejeição: Consumo Indevido — aguardar 1 hora |
| Código interno | `CONSUMO_INDEVIDO` |
| Documentos recebidos | **0** |
| Documentos persistidos | **0** |
| `notasNovas` / `notasDuplicadas` | 0 / 0 |

---

## 7. NSU final e justificativa

| Campo | Inicial | Final |
|---|---|---|
| `ult_nsu` | 196 | **196** (preservado) |
| `max_nsu` | 196 | **196** (preservado) |
| `ultimo_cstat` | 656 | **656** |
| `cooldown_ate` | (expirado) | **`2026-10-19T00:40:01.778Z`** |

**Justificativa:** regra P0.11 / `CentralNsuService` — cStat 656 **não** avança cursor; aplica cooldown explícito de 1 h. Auditoria: `NSU_PRESERVADO` / motivo `SEFAZ_NAO_MAIOR`. Resposta trazia `maxNSU=0` remoto — **ignorado** para avanço.

---

## 8. Estado final do cooldown

| Campo | Valor |
|---|---|
| Ativo | **sim** |
| Motivo | `COOLDOWN_EXPLICITO` |
| Liberação (UTC) | `2026-10-19T00:40:01.778Z` |
| Liberação (Fortaleza) | **18/10/2026, ~21:40** |

**Não tentar nova DistDFe para a empresa 1 antes dessa liberação.**

---

## 9. Outras operações fiscais

- [x] Sem `consChNFe`
- [x] Sem manifestação 210210
- [x] Sem cancelamento
- [x] Sem consulta às empresas 2 e 3
- [x] Sem importação estoque/financeiro
- [x] Sem alteração manual de NSU/flags
- [x] Sem `CDS_ALLOW_OFFICIAL_DB=1`
- [x] Sem commit/push/merge

---

## 10. Ressalvas

1. **SEFAZ 656:** a chamada foi efetiva e o pipeline P0.11 reagiu corretamente, mas **não** houve documentos novos — a SEFAZ rejeitou por consumo indevido (janela de 1 h).  
2. **Boot `database.js`:** o carregamento do módulo oficial executou `CREATE TABLE/INDEX IF NOT EXISTS` e rotinas de ensure do boot de produção (caminho operacional). Não houve ajuste manual de NSU/cooldown/flags.  
3. **Ambiente de paths:** a operação real exige `FISCAL_DIR` alinhado ao Electron (`…\ProgramData\MercantilFiscal\dados\fiscal`); sem isso o pré-voo bloqueia certificado sem SOAP.  
4. **137 histórico:** retornos 137 anteriores (~18:39) não provam ausência de NF-e em intervalos já saltados de NSU.

---

## 11. Veredito

### **APROVADO COM RESSALVAS**

A autorização de **uma** DistDFe real foi cumprida: SOAP enviado, cStat **656** confirmado, NSU **preservado**, cooldown de 1 h reaplicado, sem retry e sem outras operações fiscais.

**Próximo passo (nova autorização necessária):** após `2026-10-19T00:40:01Z`, nova consulta controlada **uma empresa por vez** (preferir espaçar empresas 2/3 se ainda elegíveis). Não repetir empresa 1 durante o cooldown.
