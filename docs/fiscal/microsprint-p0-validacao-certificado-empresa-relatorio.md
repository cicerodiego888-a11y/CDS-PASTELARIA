# Microsprint P0 — Validação real do certificado digital no cadastro da empresa

**Prioridade:** P0  
**Data:** 18/10/2026  
**Escopo:** cadastro de certificado A1 (.PFX) por empresa, botão TESTAR CERTIFICADO, diagnóstico da Central

Nesta etapa **não** houve SOAP SEFAZ, DistDFe, 210210, PFX de produção, abertura do banco oficial, commit, push ou merge.

---

## 1. Causa-raiz confirmada

No checkout atual, `POST /api/fiscal/certificado/upload` (`backend/rotas/fiscal.js`):

1. Gravava o multer em `dados/fiscal/certificados`.
2. Se havia `empresa_id`, **apagava** `certificado-empresa-{id}.pfx` com `unlinkSync` **antes** de qualquer leitura PKCS#12.
3. Persistia `certificado_path` e `certificado_senha` via `salvarConfiguracaoFiscalEmpresa` **sem** abrir o PFX.
4. Sem `empresa_id`, caía no certificado global `certificado.pfx` + `fiscal_certificado_path`.

`frontend/erp/js/gestao-empresas-fiscal.js` → `enviarCertificado()`:

- Enviava o arquivo mesmo com senha vazia.
- Exibia “CERTIFICADO DIGITAL CONFIGURADO COM SUCESSO” só com HTTP 200, sem estado criptográfico.

`empresasConfiguracaoFiscal.dtoPublicoConfiguracao`:

- `certificado_configurado = !!(path && senha)` — existência de campos, não validade.

`CentralDiagnosticoService._obterCertificado` / `CentralConfiguracaoService._montarVisaoCertificado`:

- Podiam marcar “Válido” após `carregarCertificadoPfx` no painel, ou tratar arquivo presente como configurado.
- Erro `PKCS#12 MAC could not be verified. Invalid password?` chegava cru ao operador.

A extensão `.pfx` e o preenchimento de caminho/senha **não** provavam certificado válido.

---

## 2. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `backend/services/fiscal/certificadoEstados.js` | Estados e códigos públicos |
| `backend/services/fiscal/ValidarCertificadoA1Service.js` | Validação PKCS#12 reutilizando `certificateService` |
| `backend/services/fiscal/CertificadoEmpresaService.js` | Teste temporário + substituição segura |
| `backend/services/fiscal/empresasConfiguracaoFiscal.js` | Snapshot de validação + DTO (`certificado_status`) |
| `backend/rotas/fiscal.js` | Upload validado; `POST /certificado/testar`; exige admin + `empresa_id` |
| `frontend/erp/js/gestao-empresas-fiscal.js` | Botão TESTAR CERTIFICADO; estados reais; senha obrigatória no envio |
| `frontend/erp/js/central-diagnostico.js` | Exibe mensagem de validação |
| `backend/motores/central-entradas/services/CentralConfiguracaoService.js` | Visão sem leitura criptográfica a cada refresh |
| `backend/motores/central-entradas/services/CentralDiagnosticoService.js` | Estados reais; teste local via serviço A1 |
| `tests/fiscal/validacao-certificado-empresa-a1.test.js` | Suíte isolada (PFX sintéticos) |
| `package.json` | `test:fiscal-certificado-empresa` |
| `docs/fiscal/microsprint-p0-validacao-certificado-empresa-relatorio.md` | Este relatório |

`backend/services/fiscal/certificateService.js` **não** foi duplicado: a abertura PKCS#12 continua em `carregarCertificadoPfx` / `extrairCnpjDoCertificadoPem`.

---

## 3. Estratégia de validação criptográfica

1. Arquivo em pasta temporária (`dados/fiscal/certificados/tmp` ou `FISCAL_DIR` de teste).
2. `carregarCertificadoPfx(caminho, senha)` (node-forge PKCS#12) — confirma MAC, chave privada e certificado folha.
3. Extração de validade (`notBefore` / `notAfter`) e titular (CN/O).
4. CNPJ do certificado (`OID 2.16.76.1.3.3` ou rótulo CNPJ) confrontado com o CNPJ da **empresa selecionada**.
5. Sem HTTP, SOAP, DistDFe ou evento 210210.

Classificação de erro (quando a biblioteca permite distinguir):

| Evidência | Estado | Código |
|---|---|---|
| MAC / Invalid password | `SENHA_INVÁLIDA` | `CERTIFICADO_SENHA_INVALIDA` |
| ASN.1/DER, arquivo ausente, PFX sem chave/cert | `ARQUIVO_INVÁLIDO` | `CERTIFICADO_ARQUIVO_INVALIDO` |
| `notAfter` no passado | `EXPIRADO` | `CERTIFICADO_EXPIRADO` |
| CNPJ do PFX ≠ CNPJ da empresa | `CNPJ_DIVERGENTE` | `CERTIFICADO_CNPJ_DIVERGENTE` |
| Demais | `ERRO_DE_VALIDACAO` | `CERTIFICADO_ERRO_VALIDACAO` |

Senha **nunca** entra em log, auditoria, mensagem ou JSON. O texto técnico `PKCS#12 MAC could not be verified` é traduzido na resposta; o detalhe sanitizado fica só no log `[certificado-a1]`.

Substituição segura: copiar o PFX atual para `.bak` → gravar o novo no destino estável `certificado-empresa-{id}.pfx` → persistir path/senha + snapshot → só então apagar `.bak` e o temporário. Falha de validação ou de banco restaura o `.bak` (ou remove o destino se ele não existia).

---

## 4. Contratos das rotas

Autenticação: `verificarToken` + `exigirRecurso('fiscal')` (já no `app.use`) **e** perfil `ADMIN` / `SUPER_ADMIN` / `role=admin`.

### `POST /api/fiscal/certificado/upload`

Multipart: `certificado` (.pfx), `empresa_id`, `certificado_senha`.

- `empresa_id` obrigatório — **sem** fallback para `certificado.pfx` global.
- Senha vazia ou validação falha → HTTP 400, certificado anterior intacto.
- Sucesso → `{ success, message, empresa_id, certificado_status: "VÁLIDO", certificado_validado: true, sefaz_chamado: false, ... }`.

### `POST /api/fiscal/certificado/testar`

Multipart opcional: arquivo + senha (teste temporário, **não persiste** path/senha) **ou** só `empresa_id` (usa PFX e senha já salvos daquela empresa).

Temporário é apagado em sucesso, erro e `finally`.

`POST /api/fiscal/config/certificado/testar` (UI antiga) permanece, apenas com mensagem sanitizada.

---

## 5. Testes executados e resultados

Isolamento: Temp `cds-preload-*`. `database.js` **não** carregado na suíte A1. PFX gerados com node-forge (512 bits), não de produção.

| # | Caso | Resultado |
|---|---|---|
| 1 | PFX válido + senha correta | **OK** — `VÁLIDO` |
| 2 | Senha errada | **OK** — `CERTIFICADO_SENHA_INVALIDA`, anterior “preservado” na mensagem |
| 3 | Texto renomeado para `.pfx` | **OK** — `ARQUIVO_INVÁLIDO` |
| 4 | Arquivo corrompido | **OK** — falha (ASN.1) |
| 5 | Expirado | **OK** — `EXPIRADO` |
| 6 | CNPJ divergente | **OK** — bloqueio |
| 7 | Upload inválido não substitui o anterior | **OK** — bytes do PFX anterior idênticos |
| 8 | Falha de persistência | **OK** — destino e DTO anteriores intactos |
| 9 | Teste temporário não persiste | **OK** — empresa B continua `NÃO_CONFIGURADO`; tmp removido |
| 10 | Empresa A ≠ certificado B | **OK** — arquivos e CNPJ isolados |
| 11 | Empresa ausente | **OK** — `EMPRESA_OBRIGATORIA`, sem fallback global |
| 12 | Sem senha/PEM no DTO e nas mensagens | **OK** |
| 13 | Sem SEFAZ / DistDFe / 210210 no serviço | **OK** — `sefaz_chamado: false` |
| 14 | UI TESTAR CERTIFICADO, sem falso positivo | **OK** |
| 15 | Teste do salvo usa empresa correta | **OK** |
| — | Fonte das rotas: valida antes de `unlink` do destino | **OK** |

**16/16** em `tests/fiscal/validacao-certificado-empresa-a1.test.js`.

Regressão:

| Suíte | Resultado |
|---|---|
| `gestao-fiscal-visual-05-15` | **18/18** |
| `rc2-diagnostico` (isolado) | **9/9** — Temp `cds-preload-GuFQUY` |

---

## 6. Evidência de preservação do certificado anterior

No teste 7: após upload válido, um `.pfx` falso foi enviado. A API rejeitou (`ARQUIVO_INVÁLIDO`). `fs.readFileSync` do destino `certificado-empresa-1.pfx` permaneceu **byte a byte** igual ao arquivo anterior. O DTO continuou `certificado_validado: true`.

No teste 8: `salvarConfiguracaoFiscalEmpresa` injetado lança erro após a cópia no disco; o destino foi restaurado do `.bak` e a configuração pública permanece válida.

---

## 7. Banco oficial e SEFAZ

| Item | Estado |
|---|---|
| Banco oficial / WAL / SHM | **não** abertos |
| `database.js` na suíte A1 | **não** carregado |
| SOAP / DistDFe / 210210 | **não** |
| PFX de produção | **não** usados |
| NSU / cooldown / Central operacional | **não** alterados |
| Git commit / push / merge | **não** |

---

## 8. Diagnóstico da Central Inteligente

O painel **não** relê o PKCS#12 a cada refresh. Usa snapshot persistido (`certificado_validacao_status` etc.).

Estados: `NÃO_CONFIGURADO`, `CONFIGURADO_NÃO_VALIDADO`, `VÁLIDO`, `SENHA_INVÁLIDA`, `ARQUIVO_INVÁLIDO`, `EXPIRADO`, `CNPJ_DIVERGENTE`, `ERRO_DE_VALIDACAO`.

Arquivo existente + senha gravada **sem** snapshot ⇒ `CONFIGURADO_NÃO_VALIDADO`, não `VÁLIDO`.

O botão “Testar certificado” do diagnóstico, com `empresaId`, chama `testarCertificadoEmpresa` (local). Sem empresa, valida o caminho do contexto sem DistDFe.

---

## 9. Limitações ainda existentes

1. Certificados já gravados **antes** desta sprint ficam `CONFIGURADO_NÃO_VALIDADO` até **TESTAR CERTIFICADO** ou um novo upload válido.
2. Upload legado da tela Fiscal antiga **sem** `empresa_id` passa a retornar `EMPRESA_OBRIGATORIA` (o cadastro da empresa sempre envia o id).
3. Não há validação de cadeia ICP-Brasil / AC raiz — apenas PKCS#12 + identidade + validade + CNPJ.
4. `POST /config/certificado/testar` ainda aceita caminho arbitrário no body (UI antiga); não é o fluxo do cadastro da empresa.
5. `PRONTA` fiscal administrativa continua usando “path+senha preenchidos” para o campo certificado, para não rebaixar em massa empresas já operacionais; a **aba Certificado** e o **diagnóstico** é que mostram o estado real.
6. Emissão NFC-e no momento do envio ainda abre o PFX via `certificateService`; esta sprint cobre cadastro/teste, não o pipeline de autorização.

---

## 10. Critérios de aceite

| Critério | |
|---|---|
| Senha errada rejeitada antes da persistência | **atendido** |
| Certificado anterior intacto em falha | **atendido** (testes 7 e 8) |
| Botão TESTAR CERTIFICADO no cadastro | **atendido** |
| Resultado exibido vem da validação real | **atendido** (`data.ok` / API) |
| Central diferencia configurado × validado | **atendido** |
| Isolamento multiempresa e ausência de transmissão | **atendido** (testes 10 e 13) |

**Microsprint concluída** para o cadastro A1 da empresa. Homologação SEFAZ real **não** foi liberada.
