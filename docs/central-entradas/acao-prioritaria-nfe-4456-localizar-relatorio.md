# Ação prioritária — Localizar NF-e 4.456 (Central Pastelaria)

**Data/hora da operação DistDFe:** `18/10/2026, 22:23:28` → `22:23:31` (**America/Fortaleza**)  
**UTC:** `2026-10-19T01:23:28.369Z` → `2026-10-19T01:23:31.804Z`  
**CorrelationId:** `765787ce-3191-468b-b693-4aaf15c46585`  
**Veredito operacional:** **Cenário B** — SEFAZ respondeu sem documentos (cStat **656**); NF-e 4.456 **não** persistida  
**Aceite do caso 4456:** **NÃO ATINGIDO** nesta janela (SEFAZ não disponibilizou documentos na consulta)

---

## 1. Escopo e proteções

| Item | Cumprido |
|---|---|
| Somente CNPJ destinatário informado (empresa 3) | Sim |
| Máximo 1 DistDFe após liberação | Sim |
| Sem `consChNFe` / 210210 / cancelamento | Sim |
| Sem retry automático em 656/137/erro | Sim |
| Sem UPDATE manual de NSU/cooldown/flags | Sim |
| Autorização explícita / mutex / sticky FILA / barreira runtime | Preservados |
| Certificados/tokens/senhas no relatório | Não expostos |

---

## 2. Diagnóstico imediato (somente leitura)

### 2.1 Onde está o banco da Pastelaria

| Caminho | Conteúdo |
|---|---|
| `C:\ProgramData\MercantilFiscal\dados\mercadao.db` (default Electron) | **Outro cliente** — `empresas=0`, NSU de CNPJ `****-0183`, **sem** CNPJs `38204469*` |
| `C:\ProgramData\MercantilFiscal\dados-pastelaria\mercadao.db` | **Pastelaria** — empresas 1/2/3 (`****-15` / `****-87` / `****-04`), sync automática `true` |

**Achado crítico:** com `npm start` / Electron no `DB_DIR` padrão (`…\dados`), a UI **não** opera o banco da Pastelaria. A validação desta ação usou explicitamente `dados-pastelaria`.

### 2.2 Empresa destinatária (alvo)

| Campo | Valor |
|---|---|
| `empresaId` | **3** |
| CNPJ | `**.***.***/****-04` |
| Ambiente | **1 (produção)** |
| OPERACAO_REAL | **ativa** (`temTokenSeed=true`) |
| Certificado em disco | `fiscal/certificados/certificado-empresa-3.pfx` **existe** sob `dados-pastelaria` |
| Path gravado no banco | aponta para `…\dados\fiscal\certificados\certificado-empresa-3.pfx` (**arquivo ausente**) |

### 2.3 NSU / FILA / cooldown (antes da operação)

| Campo | Valor |
|---|---|
| `ultNSU` / `maxNSU` | `000000000000035` / `000000000000035` |
| `ultimo_cstat` | `656` |
| `cooldown_ate` | `2026-10-18T23:31:28.357Z` (**já expirado**) |
| Bloqueio local | **`FILA_ESGOTADA` sticky** (legítimo: ult=max + cStat 656; timer de 1 h **não** libera) |
| NF-e 4456 no banco | **ausente** |

### 2.4 Pré-voo

1ª tentativa (antes do remap de PFX): bloqueio `CERTIFICADO` — arquivo no path gravado não existia.  
Após correção de resolução: pré-voo `FILA_ESGOTADA` → liberação admin → pré-voo **OK** / decisão `PRONTO_PARA_CONSULTA`.

---

## 3. Liberação administrativa da fila

| Campo | Valor |
|---|---|
| Procedimento | `CentralOperacaoFiscalRealService.liberarFilaEsgotada` (fluxo oficial CE-PASTELARIA-02) |
| Perfil | ADMIN |
| SOAP | **não** |
| NSU alterado | **não** (`35`/`35` preservados) |
| `ultimo_cstat` após | `FILA_LIBERADA_OP` |
| Pré-voo após | `ok: true` |

---

## 4. Consulta DistDFe real (única)

| Campo | Valor |
|---|---|
| Fluxo | `CentralEntradasOrchestrator.consultarDfeReal` · origem `CONSULTA_DFE_REAL` |
| Endpoint | `https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx` |
| HTTP | **200** |
| SOAP | **1387 ms** |
| `consultaExecutada` | **true** |
| cStat | **656** |
| xMotivo (sanitizado) | Consumo indevido — aguardar 1 hora |
| Documentos retornados | **0** |
| Notas novas / duplicadas | **0 / 0** |
| NF-e 4456 persistida | **não** |

### NSU antes / depois

| | Antes | Depois |
|---|---|---|
| ultNSU | 35 | **35** (preservado) |
| maxNSU | 35 | **35** (preservado) |
| ultimo_cstat | FILA_LIBERADA_OP → consulta | **656** |
| cooldown_ate | (expirado) | **`2026-10-19T02:23:31.759Z`** (~23:23 Fortaleza) |

**Não repetir DistDFe desta empresa antes desse horário.**

---

## 5. Classificação do cenário

| Cenário | Status |
|---|---|
| **A** — requisição não enviada | Ocorreu nas tentativas iniciais (cert path / FILA); **corrigido** antes do SOAP |
| **B** — SEFAZ sem documentos | **Resultado da consulta autorizada** (656, 0 docs) |
| **C** — docs retornados | Não |
| **D** — persistida mas fora da lista | Não (nada persistido) |

HTTP 200 **não** valida a Central para a NF-e 4.456: a SEFAZ rejeitou por consumo indevido e **não** enviou o documento.

---

## 6. Correções mínimas aplicadas (causas locais comprovadas)

| Causa | Correção | Arquivo |
|---|---|---|
| Path PFX absoluto obsoleto (`…\dados\fiscal\…`) com DB em `dados-pastelaria` | Remap em memória para `FISCAL_DIR/certificados/certificado-empresa-<id>.pfx` | `CentralConfiguracaoService.js` |
| Gate A1 recusava path fora da raiz atual | Fallback seguro para o PFX canônico sob a pasta de certificados da empresa | `CertificadoEmpresaService.js` |
| FILA sticky sem caminho admin (já CE-02) | Liberação usada nesta operação | (já existente) |

**Não** alterado: sticky FILA, barreira runtime, mutex, autorização explícita, NSU manual, outras empresas.

**Fora do código (operacional):** o Electron default ainda aponta para `…\dados` (cliente errado). Para a UI Pastelaria operar este banco, `DB_DIR`/`FISCAL_DIR` precisam apontar para `dados-pastelaria` (ou equivalente operacional).

---

## 7. Testes executados

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/sprint-ce-pastelaria-02-correcao-busca-nfe.test.js
```

**9/9 pass** (inclui regressão do remap PFX + gate seguro).

Sem consulta SEFAZ nos testes automatizados.

---

## 8. Evidência adicional necessária para aceite da NF-e 4.456

1. Após `2026-10-19T02:23:31Z`, **nova autorização** para **uma** DistDFe da empresa 3 (mesmo fluxo).  
2. Se cStat **138** com documentos: confirmar persistência da chave/número **4456**, série 1, valor R$ 3.526,00, emitente `****-0188`, destinatário `****-04`.  
3. Se cStat **137** / fila no topo sem a nota: a distribuição pode **não** ter a NF-e (já consumida noutro NSU, destinatário diferente, ou ainda não disponível) — aí avaliar `consChNFe` **só** com autorização específica (fora desta ação).  
4. Garantir que a aplicação em uso abre `dados-pastelaria`, não o `dados` default.

---

## 9. Riscos residuais

- Cooldown 656 ativo na empresa 3 até ~23:23 Fortaleza.  
- Empresa 1 ainda em FILA sticky pós P0.12 (não consultada aqui).  
- `sync_automatica=true` no banco Pastelaria pode competir por cota SEFAZ se o app subir nesse DB.  
- Paths absolutos antigos permanecem gravados no banco (remap só em runtime; opcional futura correção administrativa de path).

---

## 10. Conclusão

A Central **conseguiu** (nesta ação) liberar a FILA sticky, emitir autorização OPERACAO_REAL e transmitir **uma** DistDFe real para o destinatário `****-04`. A SEFAZ respondeu **656** sem documentos; a NF-e **4.456** **não** foi recebida nem persistida.

**Não declarar a busca da NF-e 4.456 como validada.** Declarar apenas: bloqueios locais de certificado/path e FILA foram diagnosticados e tratados; a consulta real ocorreu; o resultado SEFAZ foi consumo indevido sem payload.
