# Microsprint P0.1 — Segurança das rotas legadas e consistência do status fiscal

**Prioridade:** P0  
**Data:** 18/10/2026  
**Dependência:** Microsprint P0 — Validação real do certificado A1  
**Escopo:** rota legada de teste de certificado, isolamento multiempresa, semântica dos estados fiscal/admin/criptográfico, diagnóstico sem revalidação criptográfica em todo refresh

Nesta etapa **não** houve SOAP SEFAZ, DistDFe, 210210, PFX de produção, abertura do banco oficial, alteração de NSU/cooldown/filas da Central, alteração do pipeline de autorização NFC-e, commit, push ou merge.

---

## 1. Causa-raiz confirmada

No relatório P0 (`docs/fiscal/microsprint-p0-validacao-certificado-empresa-relatorio.md`, seção 9 item 4), a rota legada `POST /api/fiscal/config/certificado/testar` ainda aceitava caminho arbitrário no body (UI antiga / `frontend/erp/js/fiscal.js`).

Riscos remanescentes confirmados nesta auditoria:

1. **Caminho do cliente** — campos `certificadoPath`, `certificado_path`, `path` ou `caminho` podiam apontar para qualquer arquivo legível pelo processo Node (traversal, arquivo de outra empresa, path absoluto fora do diretório protegido).
2. **Isolamento multiempresa incompleto na rota legada** — sem `empresa_id` obrigatório resolvido contra permissões e sem amarração do basename `certificado-empresa-{id}.pfx` ao diretório `dados/fiscal/certificados`.
3. **Semântica ambígua de “pronto”** — `certificado_configurado = path && senha` e o status administrativo `PRONTA` continuavam a ser lidos por operadores como prova de validade criptográfica; certificados legados sem snapshot podiam ser interpretados como válidos.
4. **Diagnóstico** — risco residual de confundir presença de arquivo com sucesso criptográfico se o painel reabrisse o PKCS#12 a cada refresh (já mitigado no P0; reforçado aqui com campos explícitos e testes).

---

## 2. Rotas auditadas e contratos antes / depois

### 2.1 `POST /api/fiscal/config/certificado/testar` (legado)

| | Antes | Depois |
|---|---|---|
| Auth | variável / frágil | `exigirAdminFiscal` |
| Body | podia enviar `certificadoPath` + senha | **rejeita** qualquer path do cliente (`CERTIFICADO_CAMINHO_NEGADO`) |
| Empresa | opcional / implícita | `empresa_id` **obrigatório** |
| Arquivo | `carregarCertificadoPfx(caminhoDoCliente)` | resolve apenas path persistido da empresa via `resolverCaminhoCertificadoEmpresaSeguro` + `testarCertificadoEmpresa` |
| Resposta | mensagem genérica | DTO estruturado (`estado`, `codigo`, `mensagem`, `sefaz_chamado: false`) sem senha/PFX |

### 2.2 `POST /api/fiscal/certificado/testar` e `POST /api/fiscal/certificado/upload`

Já endurecidos no P0; P0.1 reforça `rejeitarCaminhoCliente(req.body)` e autorização via `autorizarOperacaoCertificadoEmpresa`.

### 2.3 Frontend legado

`frontend/erp/js/fiscal.js` → `testarCertificadoFiscal()`:

- **Antes:** podia enviar path do campo de UI.
- **Depois:** envia apenas `{ empresa_id, certificado_senha? }` — sem path.

Cadastro de empresas (`gestao-empresas-fiscal.js`) continua em `/api/fiscal/certificado/testar` com `empresa_id` explícito.

### 2.4 Diagnóstico Central

`CentralDiagnosticoService.testarCertificado` exige `empresaId`; sem empresa retorna `EMPRESA_OBRIGATORIA` e **não** abre PFX. Refresh de visão usa snapshot persistido (`CentralConfiguracaoService._montarVisaoCertificado`), sem PKCS#12 completo.

---

## 3. Arquivos alterados (escopo P0.1)

| Arquivo | Papel |
|---|---|
| `backend/services/fiscal/CertificadoEmpresaService.js` | `rejeitarCaminhoCliente`, `resolverCaminhoCertificadoEmpresaSeguro`, `autorizarOperacaoCertificadoEmpresa` |
| `backend/services/fiscal/certificadoEstados.js` | Códigos (`CAMINHO_NEGADO`, `EMPRESA_NAO_AUTORIZADA`) + `snapshotInvalidadoPorSubstituicao` |
| `backend/services/fiscal/empresasConfiguracaoFiscal.js` | DTO: `status_administrativo`, `certificado_estado_configuracao`, `apto_certificado_criptografico`; invalidação de snapshot ao trocar path/senha |
| `backend/rotas/fiscal.js` | Rota legada segura; rejeição de path em upload/testar |
| `frontend/erp/js/fiscal.js` | Contrato sem path; exige `empresa_id` |
| `backend/motores/central-entradas/services/CentralDiagnosticoService.js` | Teste só com `empresaId`; sem SEFAZ |
| `backend/motores/central-entradas/services/CentralConfiguracaoService.js` | Visão por snapshot (sem crypto a cada refresh) |
| `tests/fiscal/seguranca-rotas-legadas-status-fiscal-p0-1.test.js` | Suíte obrigatória 1–18 (+ admin/vínculo) |
| `package.json` | Script `test:fiscal-certificado-p0-1` |
| `docs/fiscal/microsprint-p0-1-seguranca-rotas-legadas-status-fiscal-relatorio.md` | Este relatório |

Reutilização: abertura PKCS#12 permanece em `certificateService.carregarCertificadoPfx` via `ValidarCertificadoA1Service` — sem duplicação criptográfica.

---

## 4. Matriz de autorização e isolamento multiempresa

| Cenário | Resultado |
|---|---|
| ADMIN / SUPER_ADMIN + `empresa_id` válido | Autorizado (cadastro) |
| Usuário com vínculo ativo em `usuario_empresas` | Autorizado para aquela empresa |
| Usuário sem vínculo | `403` / `EMPRESA_NAO_AUTORIZADA` **antes** de ler o PFX |
| Empresa inexistente / id inválido | Bloqueio (`EMPRESA_OBRIGATORIA` / não encontrada) |
| Body com path absoluto, `../`, path fora da raiz, basename de outra empresa | `CERTIFICADO_CAMINHO_NEGADO` |
| MULTIEMPRESA | Sem fallback para `certificado.pfx` global nas rotas de teste/upload por empresa |
| Empresa A altera ID/path para arquivo da B | Negado (basename + raiz + autorização) |

Contenção de arquivo:

1. Raiz resolvida: pasta de certificados do servidor (`dados/fiscal/certificados` / `FISCAL_DIR` de teste).
2. Basename obrigatório: `certificado-empresa-{empresaId}.pfx`.
3. `realpath` rejeita symlink que escape a raiz.
4. Path do cliente nunca é usado como origem de leitura.

---

## 5. Semântica dos estados

### 5.1 Administrativo

- Campo legado: `status` (ex.: `PRONTA`, incompleto, etc.).
- Campo explícito: `status_administrativo` (mesmo valor).
- Significa: empresa ativa + preenchimento administrativo/config (incluindo path+senha como “há certificado associado”).
- **Não** significa aptidão criptográfica nem liberação de emissão só por esse campo.

### 5.2 Configuração

- `certificado_configurado` — path e senha preenchidos.
- `certificado_estado_configuracao` — `CONFIGURADO` | `NÃO_CONFIGURADO`.

### 5.3 Criptográfico

- `certificado_status` / `certificado_validacao_status` — resultado real da validação A1.
- `certificado_validado` / `apto_certificado_criptografico` — `true` **somente** se estado = `VÁLIDO` (snapshot persistido após teste/upload bem-sucedido).

Estados criptográficos:

| Estado | Significado |
|---|---|
| `NÃO_CONFIGURADO` | Sem path/senha |
| `CONFIGURADO_NÃO_VALIDADO` | Path+senha (ou legado sem snapshot); **não** inventa sucesso |
| `VÁLIDO` | Última validação PKCS#12 OK + CNPJ alinhado |
| `SENHA_INVÁLIDA` / `ARQUIVO_INVÁLIDO` / `EXPIRADO` / `CNPJ_DIVERGENTE` / `ERRO_DE_VALIDACAO` | Falhas explícitas |

**Decisão sobre `PRONTA`:** preservado o significado administrativo legado para evitar rebaixamento em massa. Aptidão criptográfica exposta pelos campos novos. Documentação de contrato: presença de path+senha **não** produz `certificado_validado = true` por inferência.

**Substituição de certificado:** alteração de path ou senha sem campos de validação na mesma gravação invalida o snapshot (`snapshotInvalidadoPorSubstituicao` → `CONFIGURADO_NÃO_VALIDADO`).

---

## 6. Testes executados

Isolamento: `preloadIsolamentoBanco.js` / banco temporário sob `%TEMP%\cds-preload-*`. Suítes P0 e P0.1 **não** carregam `database.js` do processo oficial.

### 6.1 `test:fiscal-certificado-p0-1` (obrigatórios)

Comando:

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/fiscal/seguranca-rotas-legadas-status-fiscal-p0-1.test.js
```

| # | Caso | Resultado |
|---|---|---|
| 1 | Rota legada rejeita caminho absoluto | OK |
| 2 | Rejeita traversal `../` | OK |
| 3 | Rejeita certificado fora do diretório protegido | OK |
| 4 | Não aceita certificado de outra empresa (nome/path) | OK |
| 5 | Empresa ausente bloqueada | OK |
| 6 | Empresa não autorizada bloqueada | OK |
| 7 | Empresa A não valida certificado da B | OK |
| 8 | Nenhuma rota MULTIEMPRESA usa fallback global (fonte) | OK |
| 9 | Antigo sem snapshot → `CONFIGURADO_NÃO_VALIDADO` | OK |
| 10 | Path+senha não inferem validade criptográfica | OK |
| 11 | Substituição invalida snapshot | OK |
| 12 | Válido → estado coerente | OK |
| 13 | Senha errada permanece inválida | OK |
| 14 | Expirado identificado | OK |
| 15 | CNPJ divergente bloqueado | OK |
| 16 | Diagnóstico sem leitura criptográfica a cada refresh | OK |
| 17 | Sem SEFAZ/manifestação | OK |
| 18 | Senha/PFX ausentes de DTO/resposta/logs de contrato | OK |
| — | Admin opera; vínculo A OK / B bloqueado | OK |

**Resultado:** 19 ok, 0 falha(s).

### 6.2 Regressões

| Suíte | Isolamento | Resultado |
|---|---|---|
| `test:fiscal-certificado-empresa` (`validacao-certificado-empresa-a1.test.js`) | preload temp | 16 ok, 0 falha(s) |
| `gestao-fiscal-visual-05-15` | suíte própria (sem abrir oficial) | 18/18 ok |
| `rc2-diagnostico` | preload → `%TEMP%\cds-preload-*\mercadao.db` | 9 passou, 0 falhou |

`test:central-entradas` completo **não** foi reexecutado: alterações de integração com a Central nesta microsprint limitam-se a diagnóstico/visão de certificado já cobertas por `rc2-diagnostico` e pelo caso 16 da suíte P0.1.

---

## 7. Evidência — banco oficial e SEFAZ

| Item | Estado |
|---|---|
| Banco oficial `C:\ProgramData\MercantilFiscal\dados` | **não** aberto pelas suítes (preload aponta para `%TEMP%\cds-preload-*`) |
| WAL/SHM oficiais | **não** tocados pelos testes |
| `database.js` nas suítes P0 / P0.1 | **não** carregado (“BANCO DE TESTE: database.js não carregado nesta suíte”) |
| SOAP / DistDFe / 210210 / transmissão | **não** (asserções + `sefaz_chamado: false`) |
| PFX de produção | **não** (apenas PFX sintéticos em temp) |
| NSU / cooldown / filas operacionais | **não** alterados nesta microsprint |
| Pipeline autorização NFC-e | **não** modificado |
| Git commit / push / merge | **não** |

---

## 8. Riscos remanescentes (fora do escopo ou aceitos)

1. **Cadeia ICP-Brasil / AC raiz** — ainda não validada; só PKCS#12 + validade + CNPJ.
2. **`PRONTA` legado** — continua refletindo prontidão administrativa/config; UIs antigas que ignorem `apto_certificado_criptografico` podem ainda sugerir “pronto para emitir” sem snapshot `VÁLIDO`. Mitigação: campos explícitos + tela de certificado/diagnóstico.
3. **Emissão NFC-e** — no momento do envio ainda abre o PFX via `certificateService`; esta sprint não altera o pipeline de autorização.
4. **Config fiscal global** (`GET/PUT /api/fiscal/config` sem empresa) — permanece para modo não-multiempresa / legado; rotas de **teste/upload por empresa** não usam fallback global.
5. **Homologação SEFAZ real** — não liberada por esta microsprint.

Nenhum desses itens foi “corrigido em silêncio”; permanecem documentados para sprints futuras.

---

## 9. Preservação das alterações locais

- Nenhum `git commit`, `push`, `merge`, `reset --hard` ou comando destrutivo.
- Working tree permanece com as alterações pré-existentes (Central de Entradas, fiscal, etc.) mais as mudanças desta microsprint.
- Contagem aproximada no momento do relatório: dezenas de arquivos modificados/não rastreados preservados no workspace.

---

## 10. Critérios de aceite

| Critério | |
|---|---|
| Nenhuma rota de teste aceita caminho arbitrário | **atendido** |
| Isolamento multiempresa comprovado | **atendido** (testes 4–8, 7) |
| Estados admin / config / criptográfico distinguíveis | **atendido** |
| Legados sem snapshot não promovidos a `VÁLIDO` | **atendido** (teste 9) |
| Sem desativação em massa de empresas | **atendido** (`PRONTA` preservado) |
| Suítes executadas documentadas | **atendido** |
| Sem SEFAZ real nem banco oficial nas suítes | **atendido** |

**Microsprint P0.1 aprovada** nos critérios acima. Homologação SEFAZ real e endurecimento do pipeline de emissão **não** fazem parte deste aceite.
**)
