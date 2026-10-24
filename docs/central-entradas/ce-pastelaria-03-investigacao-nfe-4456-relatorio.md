# CE-PASTELARIA-03 — Investigação definitiva da NF-e 4456 não importada

**Tipo:** investigação (sem correção executada · sem SEFAZ)  
**Data:** 18–19/10/2026  
**Referência funcional CDS Sistemas:** `C:\projetos\CDS_SISTEMAS_CORRECAO_FISCAL_NAO-F`  
**Veredito:** **CAUSA RAIZ DA NÃO-IMPORTAÇÃO COMPROVADA** (ausência do documento no retorno DistDFe) · correção **apenas proposta**

---

## 1. Objeto investigado

| Campo | Valor |
|---|---|
| Número / série | 4456 / 1 |
| Chave | `23261031255007000188550010000044561664976903` |
| Emitente (CNPJ na chave) | `31255007000188` (Nossa Massa) |
| Destinatário informado | `38.204.469/0002-04` → empresa **3** |
| Valor / emissão | R$ 3.526,00 · 08/10/2026 |
| Estrutura da chave | UF `23` · AAMM `2610` · mod `55` · série `001` · nNF `4456` — **coerente** |

---

## 2. Proteções respeitadas

- [x] Sem DistDFe / consChNFe / 210210 / SOAP  
- [x] Sem abrir/alterar banco oficial nesta sprint  
- [x] Sem mutar NSU, cooldown, flags, OPERACAO_REAL, certificados  
- [x] Sem liberar FILA de novo  
- [x] Sem `database.js` de produção  
- [x] Sem commit/push/merge  
- [x] Correção **não** aplicada — só proposta (§8)

Evidências de produção usadas: coletas RO e operação já autorizadas em sprints anteriores (`cds-pos656-diag-ro.json`, `cds-nfe4456-operacao-real.json`, relatórios CE-02 / ação 4456 / pós-656). **Nova** abertura do banco oficial **não** foi feita.

---

## 3. Comparação CDS Sistemas × CDS Pastelaria

### 3.1 Fluxo do botão “Sincronizar”

| Etapa | CDS Sistemas (ref. NAO-F) | Pastelaria (workspace) |
|---|---|---|
| 1. Botão | `sincronizarCentralEntradas()` | idem |
| 2. HTTP | **`POST /central-entradas/sincronizar`** | Se OPERACAO_REAL ativa → **`consultarDfeRealCentral()`** → **`POST /operacao-fiscal-real/consultar-dfe`**; senão bloqueia e abre painel |
| 3. Preflight | Sync orquestrado (legado) | Pré-voo OPERACAO_REAL + confirmações UI |
| 4. Decisão | Pipeline sync (versão ref.) | `CentralConsultaDistDfeDecisaoService` (cooldown / FILA / Gate / auth / mutex) |
| 5. NSU / FILA / lock | Cooldown 656; FILA sticky **não** no baseline ref. antigo | Sticky FILA (137/138/656+ult=max); mutex in-process + file lock |
| 6. DistDFe | `distribuicaoDFe` / sync | Idem + **barreira** `avaliarAutorizacaoTransmissao` no runtime |
| 7–8. 137/138/656 | Interpretação DistDFe | 656 preserva NSU + cooldown 1 h; depois sticky FILA |
| 9–10. Persistência / empresa | Persistência Central | `CentralDfePersistenciaService` com **chave+empresaId** |
| 11. UI resultado | Notifica notas novas / 656 | Classifica FILA ≠ cooldown genérico; botão liberar FILA (só local) |

### 3.2 Diferenças concretas (não “copiar endpoint”)

1. **Pastelaria não usa `/sincronizar` para DistDFe real do cabeçalho** — exige OPERACAO_REAL + `consultar-dfe`. Isso é **mais restritivo**, não a causa da falha da DistDFe já executada.  
2. **CDS Sistemas** ainda dispara `/sincronizar` direto — facilita sync, mas também facilita rajadas (histórico BACKGROUND/manual).  
3. **Multi-CNPJ Pastelaria:** contexto por `empresaId` sem fallback global na consulta real.  
4. **Liberação FILA** existe só na Pastelaria (CE-02): altera estado local; **não** transmite.

**Conclusão da comparação:** a diferença de roteamento **não** explica a não-importação da 4456 após DistDFe autorizada. Explica, sim, por que sync “cego” do CDS Sistemas pode parecer “mais fácil” e ao mesmo tempo gerar mais 656.

---

## 4. Causa raiz comprovada

### Por que a Central **não importou** a NF-e 4456

**Causa raiz:** nenhuma DistDFe registrada para a empresa 3 / CNPJ `****-04` devolveu lote contendo a chave `232610…4456…`. Sem documento no retorno, o pipeline de persistência **não tem o que gravar**.

| Evidência | Fonte |
|---|---|
| DistDFe real 18/10 `18:41:15` UTC · cStat **137** · lotes=0 · ult=max=35 | `dfe_auditoria` (coleta pós-656) |
| DistDFe real 19/10 `01:23:31` UTC · cStat **656** · recebidos=0 · correlation `765787ce-…` | operação autorizada + auditoria/eventos |
| Busca local prévia por número/padrão de chave / emitente | `docs4456=[]` · `nota4456EvidenciaLocal=false` |
| Chave ausente no workspace (docs/tests, exceto esta suíte) | teste isolado §11 |
| Maior NF Nossa Massa local na emp.3 | **4435** (23/09/2026) — anterior à 4456 |

**Não se conclui** que a NF-e “não existe na SEFAZ”. Conclui-se apenas que **não entrou no payload DistDFe** das consultas já feitas nesse CNPJ/cursor.

### O que **não** é a causa da não-importação

| Hipótese | Status |
|---|---|
| Persistência falhou após receber o XML | **Refutada** — zero docs no retorno |
| Associada a outra empresa no mesmo DB | **Sem evidência** da chave |
| Liberação FILA “deveria” ter importado | **Refutada** — liberação é local, sem SOAP |
| Só a troca CDS→`/sincronizar` resolveria | **Não comprovada** / inadequada — Pastelaria já transmitiu DistDFe |

### Contexto do 656 / bloqueios (contribuinte, não da ausência no lote)

- Cursor **35/35** + histórico de **137** no topo → SEFAZ já sinalizou “nada novo” nesse NSU.  
- Nova DistDFe após liberação FILA → **656** (consumo indevido), NSU preservado.  
- BACKGROUND com SOAP 656 no mesmo CNPJ em `22:31:28` UTC (dia 18) — **comprovado**; **não** concorrente no segundo da DistDFe `01:23:31`.  
- MIRX tentou DistDFe/consChNFe mas foi **bloqueado por auth** (sem SOAP).

---

## 5. Linha do tempo relevante (empresa 3)

| UTC | Evento |
|---|---|
| 17–18/10 | Várias `CONSULTA` DistDFe · maioria **656** · ult=35 |
| 18/10 18:41:15 | DistDFe · **137** · “Nenhum documento localizado” · lotes=0 |
| 18/10 22:31:28 | DistDFe **656** ligada a sync **`background`** |
| 18/10 23:40 | CONSULTA_DFE_REAL emp.**1** (P0.12) · 656 · cursor 196 |
| 19/10 01:23:28–31 | Liberação FILA local → DistDFe emp.**3** · **656** · 0 docs · corr. `765787ce-…` |
| Pós-op | cooldown até `02:23:31Z`; sticky FILA estrutural permanece |

---

## 6. Histórico / concorrência (síntese)

| Rotina | Pode transmitir DistDFe? | Passa decisão centralizada? | Observação |
|---|---|---|---|
| `CONSULTA_DFE_REAL` | Sim (autorizada) | Sim + auth | Caso da operação 4456 |
| `/sincronizar` (Pastelaria) | Não com OPERACAO_REAL no body | Sync sem auth OPERACAO_REAL | UI do cabeçalho **não** usa este path para real |
| BACKGROUND | Historicamente sim (registro 22:31) | Decisão com `permitirSemAutorizacao`; runtime exige auth | Flag `sync_automatica=true` — risco residual |
| abrir_central | Ciclos frequentes; cStat null recente | Sim | Muitos ciclos sem prova de SOAP recente |
| MIRX / recuperação XML | Não (auth negada nos eventos) | Motor `autorizaTransmissaoSefaz=false` | Não causou o 656 da operação |
| Liberar FILA (UI/API) | **Não** | N/A | Só estado local |

Mutex: in-process + lock file por CNPJ/ambiente — **não** houve evidência de duas DistDFe emp.3 no mesmo segundo.

---

## 7. Retorno 656 e FILA (código atual)

| Tema | Comportamento |
|---|---|
| 656 | Preserva NSU; `cooldown_ate` +1 h; não avança cursor |
| FILA sticky | Após cooldown, ult=max + cStat ∈ {137,138,656} bloqueia sem timer |
| UI | Mensagem FILA ≠ “Aguarde a liberação” genérico |
| Botão liberar | Admin + confirmação; **sem** SOAP; **não** contorna cooldown 656 ativo |
| Após liberação | Operador deve chamar **Consultar DF-e** explicitamente — não há auto-transmit na liberação |

---

## 8. Correção mínima **proposta** (não executada)

Ordem sugerida após revisão:

1. **Operacional (autorização futura):** após cooldown, liberar FILA (admin) + **uma** DistDFe emp.3; se 137/656 de novo, **parar**.  
2. **Se DistDFe continuar sem a chave:** com autorização específica, **uma** `consChNFe` da chave `232610…903` (não nesta sprint).  
3. **Observabilidade:** emitir evento `FILA_ESGOTADA_LIBERACAO_OP` em `central_entradas_eventos` (hoje só log operacional).  
4. **BACKGROUND:** garantir fail-closed total sem auth OPERACAO_REAL por empresa (já parcialmente coberto pelo runtime; auditar se algum caminho ainda transmite).  
5. **Não** restaurar o `/sincronizar` do CDS Sistemas como caminho real padrão.

Nenhuma dessas correções foi aplicada nesta sprint.

---

## 9. Testes executados

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/ce-pastelaria-03-investigacao-nfe-4456.test.js
```

| # | Caso | Resultado |
|---|---|---|
| 0 | Isolamento / recusa banco oficial | PASS |
| 1 | Parse chave 4456 | PASS |
| 2 | Cooldown bloqueia BACKGROUND e REAL | PASS |
| 3 | FILA sticky bloqueia BACKGROUND | PASS |
| 4 | UI Pastelaria: sync→consultar-dfe; liberar sem sync | PASS |
| 5 | CDS Sistemas ainda POST `/sincronizar` | PASS |
| 6 | Rotas OPERACAO_REAL / barreira `/sincronizar` | PASS |
| 7 | Runtime exige auth | PASS |
| 8 | Persistência/duplicidade por empresaId | PASS |
| 9 | Lote vazio 137 não inventa documento | PASS |
| 10 | Liberação não contorna cooldown / não altera NSU | PASS |
| 11 | Chave ausente no workspace (docs/tests) | PASS |

**12/12 pass.** Sem SEFAZ · sem banco oficial.

---

## 10. Riscos e pré-requisitos para tentativa real futura

1. Aguardar fim do cooldown emp.3 e usar liberação FILA + **uma** DistDFe autorizada.  
2. Não retry automático em 656/137.  
3. Preferir janela sem BACKGROUND transmitindo.  
4. Se DistDFe não trouxer a chave, autorizar **consChNFe** pontual (fora do escopo atual).  
5. Confirmar que a UI/app aponta ao banco Pastelaria correto (fato operacional já documentado; não reabrir seleção aqui).

---

## 11. Conclusão

A Pastelaria **não importou** a NF-e 4456 porque as DistDFe já executadas para o destinatário empresa 3 **não retornaram esse documento** (137 com lotes=0; 656 com recebidos=0), e não há evidência local da chave. A diferença de fluxo com o CDS Sistemas (auth OPERACAO_REAL vs `/sincronizar` direto) é real e importante, mas **não** é a causa da ausência do XML/metadado da 4456 após a consulta autorizada.

**Correção não executada.** Aguardando revisão da causa e da proposta (§8) antes de qualquer alteração ou nova transmissão.
