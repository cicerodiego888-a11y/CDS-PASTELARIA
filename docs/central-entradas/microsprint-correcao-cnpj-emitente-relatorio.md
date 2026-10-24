# Microsprint P0 — CNPJ do emitente na sincronização da Central

**Data:** 17/10/2026  
**Prazo do projeto:** 25/10/2026  
**Tipo:** correção da origem do CNPJ na sincronização DF-e  
**Resultado:** o serviço passa a obter o CNPJ de `empresas.cnpj` da empresa selecionada, ou informa que o cadastro daquela empresa está incompleto. DistDFe real **não** foi homologado.

---

## 1. Branch, HEAD e preservação

| Item | Valor |
|---|---|
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `124a23b75a7f849b5ae64acc6e9f959262fc4eb6` |
| Subject | `implemetação Diversas` |

Alterações locais preexistentes (2.6–2.8, correção de sync, recuperação segura, fiscal/vendas, OF-01) **preservadas**. Sem commit, push, merge ou comando destrutivo de Git.

Banco oficial `C:\ProgramData\MercantilFiscal\dados` **não** foi aberto. Sem SEFAZ, sem certificado de produção, sem 210210, sem alteração de NSU, estoque ou compras.

---

## 2. Mensagem e ponto exato

Texto reportado:

`Erro na sincronização: CNPJ do emitente não configurado. Verifique o cadastro fiscal da empresa.`

**Origem comprovada:** `CentralConfiguracaoService.obterContextoOperacional`, após carregar certificado (`certificadoPath` + senha) e validar CNPJ com menos de 14 dígitos.

O DistDFe (`validarConfigFiscal`) lança a variante curta `CNPJ do emitente não configurado` só se o contexto já chegou sem CNPJ. A UI da Central usa a mensagem do contexto operacional (`codigoErro: 'CNPJ'`).

---

## 3. Causa raiz

Fluxo auditado:

1. `listarAlvosSincronizacaoCentral` monta `{ empresaId, cnpj }` a partir de `empresas`.
2. `_sincronizarEmpresa` chama `obterContextoOperacional({ empresaId, permitirFallbackGlobal })`.
3. `_carregarFiscalDaEmpresa` usa `getFiscalConfig({ empresaId })`, que já junta `empresas.cnpj` com `empresas_configuracao_fiscal` (certificado/ambiente). **Não existe coluna CNPJ na tabela fiscal.**
4. O CNPJ oficial da arquitetura é **`empresas.cnpj`**. O global `configuracoes.cnpj` é legado.

**Defeito:** o contexto só aceitava o cadastro da empresa se certificado **e** CNPJ de 14 dígitos viessem juntos no retorno fiscal (`certOk`). Se o CNPJ oficial estava em `empresas.cnpj` e o objeto fiscal vinha sem `cnpj` (ou o fallback era acionado), o código carregava `getFiscalConfig()` **sem** `empresaId`.

Esse global tem certificado e, no ambiente real já auditado (CENTRAL-AUDIT-01), **CNPJ vazio**. Resultado: certificado “ok” + CNPJ vazio → a mensagem reportada, **mesmo com CNPJ preenchido no cadastro da empresa**.

Não era falta de `empresaId` no alvo de sync. Era **descarte do CNPJ da empresa** em favor da configuração global.

Manual, automático, agendamento e recuperação compartilham `obterContextoOperacional`. O mesmo ponto afetava todos.

---

## 4. Correção

1. Com `empresaId` válido, o CNPJ é lido de `empresas.cnpj` (`EmpresaService.buscarEmpresaPorId`), normalizado **só em memória**.
2. Configuração fiscal da empresa continua sendo a fonte de certificado, ambiente e UF.
3. Fallback global (somente EMPRESA_SIMPLES) **não** substitui o CNPJ da empresa por `configuracoes.cnpj`.
4. MULTIEMPRESA sem `empresaId` válido: `EMPRESA_CENTRAL_AUSENTE` / `EMPRESA_CENTRAL_INVALIDA` — sem CNPJ de outra empresa.
5. CNPJ ausente: `codigoErro: 'CNPJ'` e mensagem com o **id da empresa**.
6. `validarConfigFiscal` normaliza pontuação antes de exigir 14 dígitos. Certificado, ambiente e Gate **não** foram afrouxados.

Não foi criado campo novo de CNPJ. Não há CNPJ fixo nem fallback para outra empresa.

---

## 5. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `backend/motores/central-entradas/services/CentralConfiguracaoService.js` | CNPJ oficial por `empresaId`; mensagens por empresa; sem CNPJ global no MULTI |
| `backend/services/fiscal/distribuicaoDFe.js` | Validação com CNPJ normalizado; export de `validarConfigFiscal` |
| `tests/central-entradas/microsprint-cnpj-emitente.test.js` | Suíte isolada desta microsprint |
| `docs/central-entradas/microsprint-correcao-cnpj-emitente-relatorio.md` | Este relatório |

---

## 6. Testes

`DB_DIR` temporário, `CDS_FORCAR_LOCAL=1`. Banner interno apontou para Temp, não para `ProgramData`.

| Suíte | Resultado |
|---|---|
| `tests/central-entradas/microsprint-cnpj-emitente.test.js` | **10 passou, 0 falhou** |
| `npm run test:central-entradas` | **exit 0** — máquina 11, s2 8, s4 5, s5 7, s7 11, s8 8, s9 7, s10 7, rc1 9, rc2 9 |
| `tests/fiscal/distdfe-blindagem-05-43.test.js` | **8 ok, 0 falhou** |
| `tests/central-entradas/nfe-nao-localizada-sync.test.js` | **9 passou, 0 falhou** |

Casos da suíte nova: CNPJ válido; pontuado (cadastro inalterado); ausente; `empresaId` ausente/inválido; isolamento A/B; fiscal sem CNPJ no DTO mas `empresas.cnpj` presente; sync manual e automática; DistDFe rejeita CNPJ vazio.

---

## 7. Limitações da homologação

- DistDFe / SEFAZ reais **não** executados.
- CNPJ de produção das empresas **não** foi lido no banco oficial.
- Se `empresas.cnpj` da empresa selecionada estiver mesmo vazio, a sync continua recusando — agora com mensagem da **empresa**, não com o global vazio.
- Certificado, ambiente e autorização permanecem obrigatórios.

**Critério desta microsprint:** o serviço obtém o CNPJ da empresa correta ou declara cadastro incompleto. Validado em testes isolados. Consulta SEFAZ real permanece **não GO**.
