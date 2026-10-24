# Microsprint P0.3 — Proteção do certificado no pipeline NF-e modelo 55

**Prioridade:** P0  
**Data:** 18/10/2026  
**Dependência:** P0.2 — gate `exigirCertificadoAptoParaUsoFiscal` (NFC-e 65)  
**Decisão final:** **APROVADA COM RESSALVAS**

Nesta etapa **não** houve SOAP SEFAZ real, DistDFe, 210210, PFX de produção, abertura do banco oficial, alteração de NSU/cooldown/filas da Central, commit, push ou merge.

---

## 1. Causa-raiz e situação anterior

Após o P0.2, a NFC-e 65 passou pelo gate criptográfico único. Os pipelines NF-e **modelo 55** ainda:

1. Chamavam `getFiscalConfig()` **sem** `empresaId` (fallback global).
2. Abriam o PFX com `carregarCertificadoPfx` / `carregarEValidarCertificadoNfe` sem snapshot/`apto_certificado_criptografico`.
3. Assinavam e enviavam lote (`enviarLote`) / cancelamento (`enviarCancelamento`) / consulta (`consultarProtocolo`) com path cru do banco.

`PRONTA`, path+senha e existência de arquivo podiam sustentar uso fiscal sem prova criptográfica alinhada à empresa.

---

## 2. Matriz dos pontos de entrada auditados

| Ponto de entrada | Serviço | Empresa | Gate P0.3 | Transmissão possível |
|---|---|---|---|---|
| Faturamento / `emitirNfePorVendaId` | `nfeEmissorVenda` | `venda.empresa_id` | **Sim** — antes de numeração/assinatura/SOAP | Sim — após gate |
| `nfeAvulsaService` | → `emitirNfePorVendaId` | Via venda | **Sim** (convergência) | Sim — após gate |
| `CentralFaturamentoService.emitir` | → `emitirNfePorVendaId` | Via venda | **Sim** (convergência) | Sim — após gate |
| Devolução venda | `nfeDevolucaoVenda.emitirNFeDevolucaoVenda` | `venda.empresa_id` | **Sim** — antes de numeração | Sim — após gate |
| Devolução compra | `nfeDevolucaoCompra.emitirNFeDevolucaoCompra` | `compra.empresa_id` | **Sim** — antes de numeração | Sim — após gate |
| Cancelamento NF-e venda | `cancelarNfe` / `cancelarNfeCentral` | `vendas.empresa_id` da nota | **Sim** — antes de assinar evento | Sim — após gate |
| Cancelamento devolução compra | `nfeDevolucaoLifecycleService.cancelarNfeDevolucaoOficial` | `compras.empresa_id` | **Sim** | Sim — após gate |
| Cancelamento devolução venda | `nfeDevolucaoLifecycleVenda.cancelarNfeDevolucaoOficial` | `vendas.empresa_id` | **Sim** | Sim — após gate |
| Reenvio devolução | lifecycle `reenviarNfeDevolucao` | compra/venda | **Sim** — antes de `enviarLote` | Sim — após gate |
| Consulta situação devolução | lifecycle `consultarSituacaoDevolucao` | compra/venda | **Sim** — antes de `consultarProtocolo` | Sim — TLS após gate |
| Consulta central NF-e | `nfeCentralService.consultarSituacaoNfe` | venda da nota | **Sim** | Sim — após gate |
| Pré-preenchimento devolução | `prepararNfeDevolucao*` | global (só CFOP/UF) | N/A — **não abre PFX** | Não |
| Checklist faturamento `inspecionarCertificado` | `CentralFaturamentoService` | global config | **Não** (só leitura UI) | Não |
| Diagnóstico operacional NF-e | `nfeOperacionalService.executarDiagnosticoFiscal` | global | **Não** (fora do emit) | Pode chamar status SEFAZ |

---

## 3. Arquivos alterados

| Arquivo | Justificativa |
|---|---|
| `backend/services/fiscal/nfeCertificadoUso.js` | **Novo** — resolve `empresaId` + aplica gate; resposta de bloqueio |
| `backend/services/fiscal/nfeEmissorVenda.js` | Gate antes de `proximoNumeroNFeVenda` / assinatura / `enviarLote` |
| `backend/services/fiscal/nfeDevolucaoVenda.js` | Gate na emissão de devolução |
| `backend/services/fiscal/nfeDevolucaoCompra.js` | Gate na emissão de devolução |
| `backend/services/fiscal/cancelarNfe.js` | Gate no cancelamento modelo 55 |
| `backend/services/fiscal/nfeDevolucaoLifecycleService.js` | Gate em consulta / cancel / reenvio (compra) |
| `backend/services/fiscal/nfeDevolucaoLifecycleVenda.js` | Gate em consulta / cancel / reenvio (venda) |
| `backend/services/fiscal/nfeCentralService.js` | Gate na consulta; passa ctx ao cancel |
| `backend/services/fiscal/CertificadoUsoFiscalGate.js` | Comentário: escopo 65+55 |
| `tests/fiscal/protecao-certificado-pipeline-nfe-55-p0-3.test.js` | Suíte 1–22 |
| `package.json` | `test:fiscal-certificado-p0-3` |
| Relatório | Este arquivo |

Sem segunda implementação criptográfica: reutiliza `exigirCertificadoAptoParaUsoFiscal`.

---

## 4. Ordem real de validação, assinatura e transporte

### Emissão (`emitirNfePorVendaId` / devoluções)

1. Carregar documento (venda/compra).  
2. Resolver `empresaId` **sem** fallback global.  
3. `getFiscalConfig({ empresaId })` + `exigirCertificadoAptoParaUsoFiscal`.  
4. Validar destinatário / saldos (regras fiscais existentes).  
5. Consumir numeração.  
6. Montar XML → `carregarEValidarCertificadoNfe` (PEM) → assinar.  
7. `enviarLote` com path/senha já seguros.

### Cancelamento / reenvio / consulta

1. Carregar nota + empresa da venda/compra.  
2. Gate.  
3. Só então `carregarCertificadoPfx` / `enviarCancelamento` / `enviarLote` / `consultarProtocolo`.

---

## 5. Evidência de isolamento entre empresas

- Gate exige basename `certificado-empresa-{id}.pfx` na pasta protegida.  
- Teste 9: empresa A com path da B → `CERTIFICADO_CAMINHO_NEGADO`.  
- Teste 10: `empresaId` ausente → `CERTIFICADO_EMPRESA_OBRIGATORIA`.  
- Config global não é usada nos fluxos de uso fiscal alterados.

---

## 6. Testes executados

### 6.1 Nova suíte P0.3

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/fiscal/protecao-certificado-pipeline-nfe-55-p0-3.test.js
```

Isolamento: `%TEMP%\cds-preload-*`; `database.js` **não** carregado; PFX sintéticos; transporte simulado.

| Resultado | 22 ok, 0 falha(s) |
|---|---|

Casos 1–22 cobrem validade, senha, corrupção, expiração, CNPJ, ausência, `CONFIGURADO_NÃO_VALIDADO`, snapshot, isolamento A/B, empresa ausente, path externo, ordem pré-assinatura/pré-transporte, falso sucesso, wiring venda/faturamento/devolução/rotas/cancelamento, persistência, transporte não invocado em falha, compatibilidade com gate 65.

### 6.2 Regressões

| Comando / suíte | Isolamento | Resultado |
|---|---|---|
| `test:fiscal-certificado-p0-2` | preload | 19 ok |
| `test:fiscal-certificado-empresa` | preload | 16 ok |
| `test:fiscal-certificado-p0-1` | preload | 19 ok |
| `gestao-fiscal-visual-05-15` | suíte própria | 18/18 |
| `rc2-diagnostico` | preload | 9 passou |
| `isolamento-nfce-empresa-05-46` | isolarBancoTeste | 21/21 |

---

## 7. Evidência de isolamento do banco

- Guardião + `DB_DIR` temporário em todas as suítes de certificado/regressor listadas.  
- Suíte P0.3: `BANCO DE TESTE: database.js não carregado nesta suíte`.  
- Operações de dados: SQLite `:memory:` + pasta PFX em `%TEMP%`.  
- Banco oficial `C:\ProgramData\MercantilFiscal\dados` **não** aberto.

---

## 8. Confirmação de ausência de transmissão real

- Gate e harness usam apenas PKCS#12 local.  
- Casos 2, 13, 19, 21 comprovam que o callback de transporte **não** é chamado após falha.  
- Ordem na fonte: gate &lt; numeração &lt; assinatura &lt; `enviarLote`.  
- Nenhum DistDFe / 210210 / SOAP real nas suítes.  
- Respostas de bloqueio: `success: false`, `sefaz_chamado: false`.

---

## 9. Limitações e riscos remanescentes

1. **`nfeOperacionalService.executarDiagnosticoFiscal`** ainda abre PFX e pode consultar status SEFAZ com config global — diagnóstico, não emissão; **não** coberto nesta microsprint.  
2. **`CentralFaturamentoService.inspecionarCertificado`** lê PFX para checklist de UI sem o gate (não transmite).  
3. **`prepararNfeDevolucao*`** ainda usa `getFiscalConfig()` global só para UF/CFOP (sem abrir certificado).  
4. **`obterFichaDocumentalNfe`** usa config global para rótulo do emitente na ficha.  
5. Dupla abertura PKCS#12 (gate + assinatura/TLS) permanece, como no P0.2.  
6. Integração end-to-end de `emitirNfePorVendaId` com schema completo `vendas_itens`/`produtos` não foi montada (módulo ainda usa `database` global para carregar venda); prova comportamental do gate + ordem na fonte + harness.

---

## 10. Itens fora do escopo

- Alteração do pipeline NFC-e 65 (já P0.2).  
- Manifestação DF-e / Central de Entradas / NSU.  
- Homologação SEFAZ real.  
- Refatoração da numeração global `fiscal_numero_atual_nfe`.  
- Commit / push / merge.

---

## 11. Decisão final

**APROVADA COM RESSALVAS**

Todos os caminhos de **emissão, cancelamento, reenvio e consulta** aplicáveis da NF-e 55 que usam certificado para assinatura ou TLS foram mapeados e passaram a exigir `empresaId` explícito + `exigirCertificadoAptoParaUsoFiscal` antes do uso fiscal. A regressão NFC-e/certificado permanece verde. As ressalvas limitam-se a diagnósticos/UI que abrem PFX ou leem config global **sem** transmitir documento fiscal.
