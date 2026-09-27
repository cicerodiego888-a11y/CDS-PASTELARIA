# REAL-01 — Relatório do teste real controlado (1 NF-e)

**Resultado:** o ciclo completo da NF-e escolhida funcionou em produção: 210210 → 135 → distribuição → procNFe → Parser → MIIP → EM_REVISAO.

**Desvio:** durante a espera pela janela de distribuição, o app Electron do CDS foi aberto (19:41:58 local). O ciclo automático do app manifestou uma **segunda NF-e (114)**, também com 135. Por isso o critério 11 **falhou**, e a distribuição (etapa 7) não foi a consulta controlada planejada.

Horários em UTC, salvo indicação.

## 1. NF-e escolhida

| Campo | Valor |
|---|---|
| Documento | 113 |
| Chave | 23260908606343000106550080005208281025774244 |
| Número / série | 520828 / 8 |
| Emitente | JODIBE Distr. de Bebidas do Cariri (CNPJ 08606343000106) |
| NSU do resumo | 000000000000111 |
| Status inicial | RESUMO_RECEBIDO / RES_NFE, sem nenhum evento de manifestação |

**Motivo da escolha**
- **Pré-check (22:25:41):** só 113 e 114 estavam dentro da janela. As duas tinham o mesmo dhEmi e o mesmo prazo.
- **Desempate:** pela P4 (chave menor), a escolhida foi a 113.
- **Demais pendentes da Matriz:**
  - 53 EXPIRADO;
  - 10 rejeitadas com 596.
- **Outras empresas:** empresa 2 e empresa 3 com 1 EXPIRADO cada.

## 2. Contexto da empresa

| Campo | Valor |
|---|---|
| Empresa | empresaId 1, "CICERA ERICA ALVES GOMES LANCHONETE" |
| CNPJ | 38.\*\*\*.\*\*\*/0001-15 |
| Ambiente | 1 (Produção), UF CE |
| Serviço | Ambiente Nacional (cOrgao 91) |

## 3–5. Prazo

| Campo | Valor |
|---|---|
| dhEmi | 2026-09-17T19:58:07-03:00 (fonte: XML resNFe) |
| Prazo final | 2026-09-27T22:58:07Z (27/09/2026 19:58 em Brasília) |
| Tempo restante no envio | ~27 min, URGENTE |

## 6–7. Política e Gate

- **Política:** `AUTOMATICA_CIENCIA` (global).
- **Envio:** o 210210 foi feito por chamada manual confirmada de um único documento (`processarDocumento(113)`), sem servidor e sem scheduler.
- **Gate:** estado global sem 656 ou 593 ativo. `SEFAZ_GATE_ALLOW` para a empresa 1 antes do SOAP.
- **Claim:** nenhum antes; o claim atômico foi reservado e liberado.

## 8–11. Envio 210210 e retorno

- **Horário:** envio 22:30:51.630Z, retorno 22:30:52.742Z (SOAP 1047 ms, HTTP 200).
- **Endpoint:** `https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx`, runtime PLATFORM, sem fallback.
- **Lote:** cStat 128, "Lote de evento processado".
- **Evento:**
  - cStat **135**, xMotivo **"Evento registrado e vinculado a NF-e"**;
  - nProt / Id: **591264628020264** / ID591264628020264;
  - dhRegEvento 2026-09-27T19:30:52-03:00, `CNPJDest` 38204469000115, tpAmb 1.
- **Eventos gravados:** 2223 `CIENCIA_ENVIADA`, 2224 `MANIFESTACAO_ENVIADA`, 2225 `MANIFESTACAO_ACEITA`, com empresa, CNPJ mascarado e ambiente.
- **Travas do script:** 1 envio registrado; qualquer outra chave ou segundo envio seria recusado.

Retorno SOAP (integral):

```xml
<retEnvEvento versao="1.00"><idLote>1</idLote><tpAmb>1</tpAmb><verAplic>AN_1.10.5</verAplic><cOrgao>91</cOrgao><cStat>128</cStat><xMotivo>Lote de evento processado</xMotivo><retEvento versao="1.00"><infEvento Id="ID591264628020264"><tpAmb>1</tpAmb><verAplic>AN_1.10.5</verAplic><cOrgao>91</cOrgao><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>23260908606343000106550080005208281025774244</chNFe><tpEvento>210210</tpEvento><xEvento>Ciencia da Operacao</xEvento><nSeqEvento>1</nSeqEvento><CNPJDest>38204469000115</CNPJDest><dhRegEvento>2026-09-27T19:30:52-03:00</dhRegEvento><nProt>591264628020264</nProt></infEvento></retEvento></retEnvEvento>
```

**Tentativa anterior abortada (sem SOAP):** a primeira execução abriu um banco temporário, porque um `DB_DIR` da regressão ainda estava definido. A verificação prévia não encontrou o documento e abortou antes de qualquer envio. O script passou a exigir o banco oficial.

## 12–14. Distribuição

- **O que foi planejado:** uma consulta pós-ciência controlada após a janela segura (23:30:52Z).
- **O que aconteceu:** às 22:42:13 o app Electron (aberto às 19:41:58 local) executou a sincronização automática.
- **Consulta utilizada:** distNSU (sincronização automática do app), não a consulta controlada.

| Campo | Valor |
|---|---|
| NSU anterior (Matriz) | 000000000000124 / 124 |
| NSU posterior (Matriz) | 000000000000127 / 127, cStat 138, avançado pelo sistema |
| procNFe da 113 | NSU **125** (evento 2230 `DOCUMENTO_ATUALIZADO` XML_COMPLETO, 22:42:14) |
| NSU 126–127 | sem novo documento na Central (provavelmente eventos) |
| Empresas 2 e 3 | distNSU cStat 137, NSU inalterados (25 e 17) |

- **Script controlado:** não executou nenhuma consulta. Foi encerrado externamente às 22:54, antes da janela.
- **NSU:** nenhum alterado manualmente.

## 15–16. procNFe / XML completo

- **XML:** `<nfeProc>` completo (10.980 bytes), não é resNFe. Tipo PROC_NFE.
- **Chave:** a do `infNFe` e a do `protNFe` são iguais à do documento.
- **Destinatário:** CNPJ 38204469000115 (Matriz), empresa_id 1.
- **Protocolo de autorização:** cStat 100. vNF 435,84.

## 17. MIIP

Eventos 2297 `PARSER_CONCLUIDO` → 2298 `MIIP_CONCLUIDO` → 2299 `DOCUMENTO_PROCESSADO` (22:42:18–19). Fluxo automático normal, sem importação manual.

## 18. Estado final

Documento 113: **EM_REVISAO / PROC_NFE**, NSU 125, `compra_id` nulo (nenhuma entrada de compra ou estoque gerada).

## 19. Outras NF-e afetadas — **SIM**

- **NF-e 114** (520829, mesma emitente e mesmo prazo):
  - **recebeu 210210 real pelo ciclo automático do app** às 22:42:17;
  - cStat **135**, protocolo **591264628212343**, dhRegEvento 19:42:18-03:00.
- **Origem:** chamada pós-sincronização do orquestrador com política `AUTOMATICA_CIENCIA`. Não foi o scheduler novo; `CENTRAL_MANIFESTACAO_SCHEDULER=0` não teria impedido.
- **Status da 114:** RESUMO_RECEBIDO, aguardando distribuição (janela pós-ciência a partir de ~23:42Z).
- **Outros efeitos do mesmo ciclo** (comportamento esperado, sem SOAP de manifestação):
  - 58 marcações `MANIFESTACAO_FORA_DO_PRAZO` em documentos vencidos da Matriz;
  - consChNFe do motor de recuperação nos docs 7–11.

## 20. Outras empresas afetadas — **NÃO** (somente consulta)

Empresas 2 e 3 tiveram só consulta distNSU (137): NSU inalterado, nenhum documento novo, nenhuma manifestação.

## 21. Problemas encontrados

1. **Isolamento dependia do app fechado.** O plano manteve o backend desligado, mas o app foi aberto durante a espera. Com `AUTOMATICA_CIENCIA`, a primeira sincronização manifestou a 114. Para o próximo teste, isolar por política (MANUAL ou CONFIRMAR_OPERADOR durante o teste) e combinar explicitamente que o app fique fechado.
2. **A distribuição e o MIIP da 113 ocorreram pelo ciclo automático**, não pela consulta controlada. O resultado é válido, mas não foi o passo controlado previsto.
3. **`DB_DIR` residual da regressão na sessão do shell.** Não causou dano (a verificação prévia abortou). Corrigido com trava de banco oficial.

## 22. Conclusão

- **Validado em produção:**
  - o relógio da XML-02 (a 113 teria sido tratada como vencida pelo cálculo antigo);
  - o 210210 com cStat 135;
  - a distribuição do procNFe pelo NSU seguinte;
  - a correspondência de chave, empresa e CNPJ;
  - o fluxo Parser → MIIP → EM_REVISAO.
- **O teste não foi "1 NF-e → 1 único 210210":** uma segunda NF-e (114) foi manifestada automaticamente pelo app.
- **Estado atual:** o app segue aberto com política `AUTOMATICA_CIENCIA`. Qualquer NF-e nova dentro da janela será manifestada automaticamente. Nenhuma configuração foi alterada por este teste.
- **Próximo passo:** aguardar auditoria antes de qualquer segundo envio.
