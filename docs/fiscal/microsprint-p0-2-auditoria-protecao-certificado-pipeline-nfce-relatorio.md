# Microsprint P0.2 — Auditoria e proteção do certificado no pipeline de emissão NFC-e

**Prioridade:** P0  
**Data:** 18/10/2026  
**Dependência:** Microsprints P0 e P0.1 — Validação do certificado A1  
**Decisão final:** **APROVADA COM RESSALVAS**

Nesta etapa **não** houve SOAP SEFAZ real, DistDFe, 210210, PFX de produção, abertura do banco oficial, alteração de NSU/cooldown/filas da Central, commit, push ou merge.

---

## 1. Causa-raiz e fluxo atual confirmado

Todas as entradas de **autorização NFC-e** convergem em `backend/services/fiscal/emissor.js` → `emitirPorVendaId`.

Antes desta microsprint o fluxo:

1. Resolvia `vendas.empresa_id` (`exigirEmpresaFiscalDaVenda`).
2. Carregava config da empresa (`resolverCredenciaisNfceDaEmpresa` / `getFiscalConfig({ empresaId })`).
3. Chamava `obterCertificadoDaEmpresa`, que só verificava **path preenchido**.
4. Checava `fs.existsSync`.
5. Abria o PFX com `carregarCertificadoPfx` para **assinatura**.
6. Reabria o PFX no transporte (`SoapTransport` / `soapClient`) para **mTLS SEFAZ**.

**Lacunas confirmadas no código:**

| Lacuna | Evidência |
|---|---|
| Snapshot `VÁLIDO` / `apto_certificado_criptografico` ignorados na emissão | `emitirPorVendaId` não lia `certificadoValidacaoStatus` |
| `CONFIGURADO_NÃO_VALIDADO` podia emitir se o arquivo abrisse | Sem gate criptográfico |
| Path não passava por `resolverCaminhoCertificadoEmpresaSeguro` | Emissão usava `config.certificadoPath` cru do banco |
| CNPJ do certificado não confrontado na emissão | Só no cancelamento (`cancelarNfce`) e no upload/teste |
| `PRONTA` administrativa não é prova criptográfica | Campo legado preservado no P0.1; emissão não deve usá-lo |

**Correção aplicada:** gate único `exigirCertificadoAptoParaUsoFiscal` (`CertificadoUsoFiscalGate.js`) chamado em `emitirPorVendaId` e `cancelarNfce` **antes** de qualquer `carregarCertificadoPfx` de uso fiscal / transporte.

---

## 2. Tabela de pontos de entrada e serviços

| Ponto de entrada | Serviço chamado | Resolução da empresa | Validação do PFX (após P0.2) | Possível transmissão |
|---|---|---|---|---|
| `POST /api/fiscal/emitir/venda/:vendaId` | `emitirPorVendaId` | `venda.empresa_id` + contexto | Gate: path seguro + snapshot + PKCS#12 + validade + CNPJ | Sim — só após gate OK |
| Checkout / `VendaFiscalService` / `emitirFiscalSeSolicitado` | `emitirPorVendaId` | `venda.empresa_id` | Mesmo gate (convergência) | Sim — após gate |
| Entrega `MotorFinalizacaoVenda` (`emitir_fiscal`) | `emitirPorVendaId` | `venda.empresa_id` | Mesmo gate | Sim — após gate |
| MUV `FiscalizarAtendimentoService` | `emitirPorVendaId` | Operação + `venda.empresa_id` | Mesmo gate | Sim — após gate |
| Cancelamento NFC-e | `cancelarNfce` | `venda.empresa_id` | Mesmo gate + CNPJ já existente no cancel | Sim — evento 110111 após gate |
| Upload/teste certificado | `CertificadoEmpresaService` | `empresa_id` explícito | `validarArquivoPfx` (sem SEFAZ) | Não |
| `PUT /fiscal/config` global | `setConfiguracao` | Global | Nenhuma crypto na gravação | Não usado por emit empresa-scoped |
| NF-e 55 / faturamento | Pipelines próprios | Empresa config | **Fora do escopo NFC-e 65** (risco remanescente) | NF-e WS |

---

## 3. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `backend/services/fiscal/CertificadoUsoFiscalGate.js` | **Novo** — gate de uso fiscal |
| `backend/services/fiscal/certificadoEstados.js` | Códigos `CERTIFICADO_NAO_VALIDADO`, `CERTIFICADO_EMPRESA_OBRIGATORIA`; `ESTADOS_BLOQUEIO_USO_FISCAL`; mensagens de uso |
| `backend/services/fiscal/emissor.js` | Chama gate; aplica `certificadoPath`/`senha` seguros antes da assinatura |
| `backend/services/fiscal/cancelarNfce.js` | Mesmo gate antes de carregar PFX |
| `backend/services/fiscal/FiscalEmpresaContextoService.js` | Status HTTP para códigos `CERTIFICADO_*` |
| `tests/fiscal/protecao-certificado-pipeline-nfce-p0-2.test.js` | Suíte obrigatória 1–16 (+ extras) |
| `tests/fiscal/isolamento-nfce-empresa-05-46.test.js` | Compat: gate injetável no T14; assert fonte T18 |
| `package.json` | Script `test:fiscal-certificado-p0-2` |
| `docs/fiscal/microsprint-p0-2-auditoria-protecao-certificado-pipeline-nfce-relatorio.md` | Este relatório |

Reutilização: `ValidarCertificadoA1Service.validarArquivoPfx` → `certificateService.carregarCertificadoPfx`. Sem segunda implementação criptográfica.

---

## 4. Política de bloqueio por estado

| Estado criptográfico | Comportamento |
|---|---|
| `VÁLIDO` | Revalida o arquivo que será carregado (PKCS#12 + validade + CNPJ); se OK, prossegue |
| `CONFIGURADO_NÃO_VALIDADO` | **Não** trata como válido; executa validação local; se OK, persiste snapshot `VÁLIDO` e libera (compatibilidade operacional sem mass demotion) |
| `SENHA_INVÁLIDA` | Bloqueia com orientação para corrigir senha / TESTAR CERTIFICADO |
| `ARQUIVO_INVÁLIDO` | Bloqueia |
| `EXPIRADO` | Bloqueia |
| `CNPJ_DIVERGENTE` | Bloqueia para a empresa selecionada |
| `ERRO_DE_VALIDACAO` | Bloqueia |
| `NÃO_CONFIGURADO` | Bloqueia e solicita configuração |

`PRONTA` / path+senha **nunca** são prova de validade criptográfica no gate.

Códigos públicos de erro (exemplos): `CERTIFICADO_SENHA_INVALIDA`, `CERTIFICADO_ARQUIVO_INVALIDO`, `CERTIFICADO_EXPIRADO`, `CERTIFICADO_CNPJ_DIVERGENTE`, `CERTIFICADO_NAO_VALIDADO`, `CERTIFICADO_ERRO_VALIDACAO`, `CERTIFICADO_EMPRESA_OBRIGATORIA`, `CERTIFICADO_CAMINHO_NEGADO`. Respostas incluem `sefaz_chamado: false` e não expõem senha/PFX.

---

## 5. Evidência de validação anterior ao uso fiscal

Em `emitirPorVendaId`:

1. `exigirCertificadoAptoParaUsoFiscal(...)` roda **antes** de `incrementaNumeroFiscal` consumir sequência em cenários de falha de certificado?  
   - Ordem atual: gate **antes** da geração de número e **antes** de `carregarCertificadoPfx` / `entregarUrlsAoTransporte`.  
   - Assim, certificado inválido não chega ao cliente SOAP.
2. Path efetivo = retorno de `resolverCaminhoCertificadoEmpresaSeguro` (basename `certificado-empresa-{id}.pfx` dentro da pasta protegida).
3. `cancelarNfce` usa o mesmo gate.

Teste de ordem na fonte (caso 15): índice de `exigirCertificadoAptoParaUsoFiscal` &lt; `carregarCertificadoPfx(config.certificadoPath` &lt; `entregarUrlsAoTransporte`.

---

## 6. Resultados dos testes

### 6.1 `test:fiscal-certificado-p0-2`

Isolamento: `preloadIsolamentoBanco` + `isolarBancoTeste` → `%TEMP%\cds-preload-*`.  
`database.js` **não** carregado nesta suíte. PFX sintéticos.

| # | Caso | Resultado |
|---|---|---|
| 1 | Válido + CNPJ ok | OK |
| 2 | Senha incorreta bloqueia antes do transporte | OK |
| 3 | Arquivo corrompido | OK |
| 4 | Expirado | OK |
| 5 | CNPJ divergente | OK |
| 6 | Ausente | OK |
| 7 | `CONFIGURADO_NÃO_VALIDADO` não é válido sem PKCS#12 | OK |
| 8 | Snapshot invalidado após troca senha/arquivo | OK |
| 9 | Empresa A não usa cert da B | OK |
| 10 | Empresa ausente / id nulo | OK |
| 11 | Path externo rejeitado | OK |
| 12 | Falha não altera arquivo armazenado | OK |
| 13 | Falha não indica emissão concluída | OK |
| 14 | Erros sem senha/PFX | OK |
| 15 | Sem transmissão/manifestação + ordem no emissor | OK |
| 16 | Rotas alternativas convergem no mesmo gate | OK |
| — | Snapshot `SENHA_INVÁLIDA` bloqueia | OK |
| — | Emissor/cancel referenciam o gate | OK |
| — | `EXPIRADO` impede transporte | OK |

**Resultado:** 19 ok, 0 falha(s).

### 6.2 Regressões

| Suíte | Isolamento | Resultado |
|---|---|---|
| `test:fiscal-certificado-empresa` | preload temp | 16 ok |
| `test:fiscal-certificado-p0-1` | preload temp | 19 ok |
| `gestao-fiscal-visual-05-15` | suíte própria | 18/18 |
| `rc2-diagnostico` | preload temp | 9 passou |
| `isolamento-nfce-empresa-05-46` | `isolarBancoTeste` | 21/21 |

---

## 7. Evidência de isolamento do banco

| Item | Estado |
|---|---|
| Banco oficial `C:\ProgramData\MercantilFiscal\dados` | **não** aberto pelas suítes (guardião + `DB_DIR` temp) |
| Suíte P0.2 | `BANCO DE TESTE: database.js não carregado nesta suíte` |
| Operações de dados nos testes | SQLite `:memory:` + pasta PFX em `%TEMP%` |

---

## 8. Confirmação de ausência de transmissão real

- Gate e testes usam apenas `validarArquivoPfx` / PKCS#12 local.
- Casos 13/15 e gate com `EXPIRADO`/`SENHA_INVÁLIDA` comprovam que `enviarAutorizacao` **não** é chamado após falha.
- Nenhum DistDFe, 210210 ou SOAP real nas suítes executadas.
- `sefaz_chamado: false` nos erros estruturados do gate.

---

## 9. Riscos remanescentes

1. **NF-e modelo 55 / faturamento / devolução** (`nfeEmissorVenda`, `CentralFaturamentoService`, `nfeDevolucaoLifecycle*`) ainda carregam PFX **sem** o gate NFC-e — fora do escopo desta microsprint; documentado para etapa futura.
2. **Dupla abertura PKCS#12** na emissão feliz (gate + assinatura + TLS) — custo aceitável; não compartilham handle materializado.
3. **Empresas legadas `CONFIGURADO_NÃO_VALIDADO`** passam a ter validação local no primeiro uso fiscal bem-sucedido (promovem snapshot). Se o PFX estiver inválido, a emissão é bloqueada — efeito desejado, não é desativação administrativa em massa.
4. **`salvarConfiguracaoFiscalEmpresa` ainda pode gravar path** sem crypto imediata; o gate na emissão/cancelamento contém o risco. Endurecer a gravação administrativa fica para sprint futura.
5. **Homologação SEFAZ real** não foi liberada.
6. Testes de integração completa `emitirPorVendaId` com schema `vendas_itens`/`produtos` não foram montados nesta suíte (alto acoplamento); a prova de ordem + harness do gate + 05.46 cobrem o contrato. Ressalva explícita.

---

## 10. Decisão final

**APROVADA COM RESSALVAS**

Critérios atendidos para o pipeline **NFC-e 65** (emissão e cancelamento):

- Mapeamento dos pontos de entrada relevantes  
- Validação do certificado antes do uso fiscal (gate único)  
- Estados de falha não interpretados como válidos  
- Vínculo empresa ↔ arquivo seguro  
- Sem transmissão SEFAZ / sem banco oficial nas suítes  
- Regressões documentadas  

Ressalvas: pipelines NF-e 55 e gravação administrativa de path sem crypto imediata permanecem como riscos documentados, não “corrigidos em silêncio”.
