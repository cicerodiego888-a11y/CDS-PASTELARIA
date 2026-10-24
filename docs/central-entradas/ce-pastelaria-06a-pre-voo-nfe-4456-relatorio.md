# CE-PASTELARIA-06A — Pré-voo operacional somente de leitura — NF-e 4456

**Tipo:** pré-voo RO (sem SEFAZ · sem mutação)  
**Coleta:** `2026-10-19T02:02:xxZ` · fuso America/Fortaleza  
**Alvo:** empresa **3** · CNPJ `38204469000204` · chave `23261031255007000188550010000044561664976903`  
**Veredito geral:** **PRÉ-VOO CONCLUÍDO — OPERAÇÃO REAL AINDA NÃO LIBERADA**

> Não houve DistDFe, consChNFe, manifestação, liberação de FILA nem alteração de NSU/cooldown/flags/certificados.

---

## 1. Método e limites

| Item | Valor |
|---|---|
| Banco lido | `C:\ProgramData\MercantilFiscal\dados\mercadao.db` |
| `dados-pastelaria` | **Ausente** (igual CE pós-656) |
| Modo | `sqlite3.OPEN_READONLY` + `PRAGMA query_only` |
| Probe escrita | `SQLITE_READONLY: attempt to write a readonly database` |
| `database.js` / migrações | **Não executados** |
| Script | `scripts/ce-pastelaria-06a-prevoo-ro.js` |
| Snapshot JSON | `%TEMP%\cds-ce06a-prevoo-ro.json` |
| Decisão | Avaliada em processo isolado com **snapshot** do NSU (sem chamar `distribuicaoDFe`) |

---

## 2. Verificações

### 1) Contexto empresa 3 / CNPJ / ambiente

| Status | **APROVADA** |
|---|---|
| Evidência | `empresas.id=3` · razão CICERA ERICA ALVES GOMES LANCHONETE · fantasia PASTELARIA DO CHEFF - Filial 3 · `cnpjDigits=38204469000204` · `ativo=1` |
| Ambiente fiscal | **1 (produção)** em `empresas_configuracao_fiscal.ambiente` |
| NSU ambiente | **1** em `central_entradas_nsu` |

---

### 2) Certificado (sem expor senha)

| Status | **APROVADA** (metadados persistidos + arquivo) |
|---|---|
| Path | `…\dados\fiscal\certificados\certificado-empresa-3.pfx` |
| Arquivo existe | **Sim** (~9546 bytes · mtime `2026-10-18T18:11:42Z`) |
| Status validação gravado | **`VÁLIDO`** (`CERTIFICADO_VALIDO`) em `2026-10-18T18:11:46Z` |
| Validade até | `2027-02-27T16:48:06.000Z` |
| CNPJ do certificado | `38204469000204` (coincide com empresa 3) |
| Senha / conteúdo PFX | **Não lidos nesta entrega** (coluna redacted; sem revalidação criptográfica nesta etapa) |

Não foi necessário reabrir o PFX com senha para o pré-voo; o mecanismo de validação A1 já havia persistido status/validade.

---

### 3) Cooldown e FILA (sem modificar)

| Status | **APROVADA** (leitura) · estado **BLOQUEADOR** |
|---|---|
| `cooldown_ate` | `2026-10-19T02:23:31.759Z` |
| Motivo vigente na coleta | **`COOLDOWN_EXPLICITO`** (~21 min restantes na coleta) |
| Sticky FILA estrutural | **Sim** (ult=max=35 + cStat 656) — prevalece **após** expirar o cooldown, sem liberação admin |
| Simulação pós-cooldown (snapshot, sem mutar DB) | `FILA_ESGOTADA` ativo; DistDFe localmente bloqueada até liberação operacional |

---

### 4) NSU e último cStat

| Status | **APROVADA** |
|---|---|
| ultNSU / maxNSU | `000000000000035` / `000000000000035` |
| ultimo_cstat | **656** |
| data_sincronizacao | `2026-10-19T01:23:31.759Z` |
| Última auditoria emp.3 | id **698** · `SYNC_RESUMO` · `CONSUMO_INDEVIDO` · cStat 656 · corr. `765787ce-…` · docs 0 |

Chave 4456 em `central_entradas_documentos`: **0 linhas**.

---

### 5) Autorização OPERACAO_REAL (sem transmitir)

| Status | **APROVADA** (ativação presente) |
|---|---|
| Chave | `operacao_fiscal_real_empresa_3` |
| ativa | **true** |
| tokenSeed | presente (não exibido) |
| empresaId | 3 · CNPJ mask `****-04` |
| tiposPermitidos | `distNSU`, `consChNFe`, `consNSU` |
| Observação | Ativação **≠** autorização de sessão emitida; DistDFe real ainda exige pré-voo UI + confirmações + emissão de token de curta duração |

---

### 6) Lock / operação em andamento

| Status | **APROVADA** (livre) |
|---|---|
| Dir locks | `%TEMP%\cds-sefaz-locks` |
| Arquivos `.lock` | **nenhum** |
| Conclusão | Sem evidência de DistDFe emp.3 em andamento neste host |

---

### 7) BACKGROUND — pode transmitir sem auth?

| Status | **APROVADA** (proteção confirmada) |
|---|---|
| Flag `sync_automatica_habilitada` | `true` (ciclo pode acordar) |
| Código CE-04/05 | `CentralSincronizacaoService` força `verificarAutorizacao: true` / `permitirSemAutorizacao: false`; origem `background` em `origemExigeAuth` |
| Avaliação com snapshot atual | BACKGROUND → **`COOLDOWN_ATIVO`** (`permitido=false`) |
| Pós-cooldown (simulado) | BACKGROUND **com ou sem** auth → **`FILA_ESGOTADA`** (`permitido=false`) |
| Conclusão | Com o código atual, BACKGROUND **não** transmite DistDFe sem OPERACAO_REAL válida; no estado atual também está bloqueado por cooldown/FILA |

---

### 8) Decisão centralizada (não transmissiva)

| Status | **APROVADA** |
|---|---|
| Modo | Snapshot NSU + `CentralConsultaDistDfeDecisaoService.avaliar` / `diagnosticarEmpresa` |
| BACKGROUND | `COOLDOWN_ATIVO` |
| CONSULTA_DFE_REAL (auth mock emp.3) | `COOLDOWN_ATIVO` |
| Diagnóstico | `COOLDOWN_ATIVO` |
| SOAP / `distribuicaoDFe` | **Não chamado** |

---

### 9) Serviço de distribuição

| Status | **APROVADA** (não chamado) |
|---|---|
| Evidência | Pré-voo usou apenas SQLite RO + decisão local; nenhum `enviarDistribuicaoDfe` / SOAP |

---

### 10) Inicialização / migração do banco oficial

| Status | **APROVADA** (não necessária) |
|---|---|
| Evidência | Leitura RO direta; `database.js` não executado; probe confirmou readonly |

---

## 3. Síntese para futura tentativa controlada

| Pré-requisito | Situação na coleta |
|---|---|
| Empresa/CNPJ/ambiente | OK |
| Certificado | OK (válido até 2027-02-27) |
| OPERACAO_REAL ativada | OK |
| Lock livre | OK |
| BACKGROUND seguro sem auth | OK (código) |
| Cooldown 656 | **Ainda ativo** até `02:23:31Z` |
| FILA sticky após cooldown | **Prevista** (exige liberação admin local **sem** SOAP, se ainda ult=max+656) |
| Documento 4456 local | **Ausente** |
| Autorização para DistDFe real | **Não concedida nesta sprint** |

**Não liberar FILA nesta etapa. Não transmitir.**

Sequência futura (só com autorização explícita humana): aguardar fim do cooldown → (se FILA sticky) liberar FILA local com evento auditável → pré-voo UI → **uma** DistDFe emp.3 → parar em 656/137/erro → `consChNFe` só com auth separada.

---

## 4. Confirmações finais

| Item | Status |
|---|---|
| Transmissão SEFAZ | **Não executada** |
| Liberação FILA | **Não executada** |
| Mutação NSU/cooldown/flags/cert | **Não** |
| Banco oficial alterado | **Não** |
| Operação real iniciada | **Não** |

A execução fiscal permanece condicionada a autorização explícita posterior.
