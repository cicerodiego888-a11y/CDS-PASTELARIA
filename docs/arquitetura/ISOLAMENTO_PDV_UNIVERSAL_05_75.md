# Isolamento arquitetural do PDV Universal (Sprint 05.75)

**Tipo:** auditoria e congelamento. Isolar ≠ remover. Congelar ≠ desativar.

**Numeração:** esta sprint reutiliza 05.75. O isolamento GET `/saude` da Central permanece em `ISOLAMENTO_SAUDE_CENTRAL_EMPRESA_05_75.md`.

## 1. Objetivo

Descobrir e documentar dependências do PDV Universal para que ele não seja base de novas implementações; o PDV Normal (`/pdv`, `frontend/pdv`) continue evoluindo; nada existente seja quebrado; remoção futura seja possível após nova auditoria.

## 2. Status do Universal

STATUS: **CONGELADO**  
TIPO: **LEGADO**  
NOVAS FUNCIONALIDADES / INTEGRAÇÕES / REGRAS / EVOLUÇÃO FUNCIONAL: **PROIBIDAS**  
CORREÇÕES CRÍTICAS: só para preservar funcionamento ou impedir impacto no resto.  
**PDV OFICIAL EM EVOLUÇÃO: PDV NORMAL** (`/pdv`).

Bandeira: comentários `STATUS: CONGELADO` nas portas HTTP, application service, tela e `pdv-acesso-oficial.js`. Sem bloqueio de runtime (não quebra produção).

## 3. Inventário de arquivos

### A — exclusivo Universal

| Arquivo | Função | Tipo | Dependência | Produção? | Remoção futura |
|---------|--------|------|-------------|-----------|----------------|
| `frontend/pdv-universal/index.html` | Tela | A | — | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal.css` | Estilo | A | — | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal.js` | Tela/orquestração UI | A | APIs Universal | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-cart.js` | Carrinho | A | — | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-identificacao.js` | Busca/identificação | A | produtos/equipamentos | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-pix.js` | PIX UI | A | núcleo PIX | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-tef.js` | TEF UI | A | `tefFluxoPagamento.js` | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-caixa.js` | Caixa UI | A | `/api/caixa` | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-entrega.js` | Entrega UI | A | núcleo entrega | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-promocao.js` | Promoção UI | A | núcleo promo | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-preco-atacado.js` | Atacado UI | A | `motor-preco-atacado.js` | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-checkout.js` | Checkout HTTP | A | POST checkout | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-pagamento.js` | Pagamento MUV | A | atendimentos Universal | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-pos-pagamento.js` | Materializar/fiscal | A | atendimentos Universal | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-comprovante-modal.js` | Preview | A | comprovante MUV | SIM | FASE FINAL |
| `frontend/pdv-universal/pdv-universal-session.js` | Sessão UI | A | — | SIM | FASE FINAL |
| `backend/rotas/pdv-universal.js` | Rotas HTTP | A | ApplicationService | SIM | FASE FINAL |
| `backend/motores/pdv-universal/PDVUniversalApplicationService.js` | Orquestração | A | adapters + MUV | SIM | FASE FINAL |
| `backend/motores/pdv-universal/contratos.js` | Contratos modo | A | MUV contratos | SIM | FASE FINAL |
| `backend/motores/pdv-universal/contexto/resolverContextoOperacional.js` | Resolver contexto | A | núcleo empresas | SIM | FASE FINAL |
| `backend/motores/pdv-universal/adaptadores/EmpresaUnicaAdapter.js` | Checkout EU | A | VendaApplicationService | SIM | FASE FINAL |
| `backend/motores/pdv-universal/adaptadores/MultiempresaAdapter.js` | Checkout ME | A | MUV | SIM | FASE FINAL |
| `backend/services/pdv-universal/PDVUniversalContextService.js` | Contexto | A | modo operacional | SIM | FASE FINAL |
| `backend/services/pdv-universal/PDVUniversalDisponibilidadeService.js` | Disponibilidade | A | reservasPublico | SIM | FASE FINAL |
| `backend/services/pdv-universal/PDVUniversalVendaAdapter.js` | Carrinho→venda | A | VAS | SIM | FASE FINAL |
| `backend/services/pdv-universal/PDVUniversalAtendimentoAdapter.js` | Carrinho→MUV | A | MUV | SIM | FASE FINAL |

### C — chamadores (produção)

| Arquivo | Função | Tipo | Por quê | Produção? | Desligar agora? |
|---------|--------|------|---------|-----------|------------------|
| `backend/server.js` | `app.use('/api/pdv-universal')` + GET HTML | C | monta módulo | SIM | NÃO |
| `frontend/erp/index.html` | Menu “PDV Universal” | C | atalho | SIM | NÃO (quebra acesso) |
| `frontend/pdv/index.html` | Nav `#nav-abrir-pdv-universal` | C | atalho a partir do Normal | SIM | NÃO AGORA |
| `frontend/erp/js/dashboard-command.js` | `abrirModuloDashboard('pdv')` | C | dashboard ERP abre Universal | SIM | NÃO AGORA (mudaria fluxo) |
| `frontend/shared/js/pdv-acesso-oficial.js` | `urlPdvUniversalOficial` | C | URL canônica Universal | SIM | NÃO |
| `frontend/shared/js/core.js` | toggle `#nav-abrir-pdv-universal` | C | visibilidade menu | SIM | NÃO |

### D — infraestrutura compartilhada (não mover)

`VendaApplicationService` / `POST /api/vendas`, `reservasPublico`, MUV (`AtendimentoMultiempresaService`, comprovante), `/api/caixa`, TEF (`tefFluxoPagamento.js`), `motor-preco-atacado.js`, `muv-comprovante-client.js`, identificação de produtos, `validarCaixaAberto`, `ContratoOperacional` / `X-Empresa-Id`, Electron IPC genérico (impressoras, não janela Universal).

### E — testes

`tests/pdv-universal/*.test.js` (33). Externos que `require` Universal: `tests/modo-operacional-global-05-38-b.test.js`, `tests/caixa/caixa-multiempresa-05-38-c.test.js`, `tests/fiscal/validacao-operacional-multiempresa-05-18-4.test.js`, `tests/fiscal/assistida-ambiente-real-05-18-5.js`, `tests/erp/auditoria-execucao-real-05-17-2.test.js`, `tests/empresas/consolidacao-operacional-multiempresa-05-19.test.js`.

### F — histórico

Docs `docs/arquitetura/*PDV_UNIVERSAL*`, `AUDITORIA_PROFUNDA_PDV_LEGADO_VS_UNIVERSAL.md` (nomenclatura antiga: `/pdv` = “legado”). **Nesta sprint `/pdv` = PDV Normal oficial.**

Não confundir: Motor Universal de Busca (MUBC), MUC, MUV — não são o PDV Universal.

## 4. Inventário de chamadores

| Quem | De onde | Por quê | Tipo | PDV Normal depende? | Desligar |
|------|---------|---------|------|----------------------|----------|
| Express | `server.js` | API + HTML | PRODUÇÃO | Não | Não |
| Operador ERP | `erp/index.html` | menu | PRODUÇÃO | Não (ERP) | Não |
| Operador PDV Normal | `pdv/index.html` | link | PRODUÇÃO | **Sim — só navegação** | Não agora |
| Dashboard ERP | `dashboard-command.js` | card PDV | PRODUÇÃO | Não | Não agora |
| `PdvAcessoOficial` | shared | URL | PRODUÇÃO | Não | Não |
| Suítes `tests/pdv-universal` | Node | regressão legado | TESTE | Não | Não apagar |
| Testes 05.38 / fiscal / ERP / empresas | vários | contrato/contexto | TESTE | Não | Não |

IPC Electron: **nenhum** handler específico do Universal. `electron.js` / `electron-pdv.js` não abrem `/pdv-universal`. Comprovante/impressão são genéricos (D).

## 5. Inventário de rotas

Montagem: `app.use('/api/pdv-universal', verificarToken, rotas)` e `GET /pdv-universal` → `index.html` (mesmo recurso de licença `pdv` que `/pdv`).

| Método | Endpoint | Arquivo | Service | Consumidor | Produção | Compartilhado |
|--------|---------|---------|---------|------------|----------|---------------|
| GET | `/pdv-universal/` | `server.js` | HTML | browser | SIM | licença pdv |
| GET | `/api/pdv-universal/contexto` | `rotas/pdv-universal.js` | `obterContexto` | tela | SIM | modo operacional |
| PUT | `/api/pdv-universal/contexto/empresa` | idem | `selecionarEmpresa` | tela | SIM | X-Empresa-Id |
| GET | `/api/pdv-universal/produtos/:id/disponibilidade` | idem | `consultarDisponibilidadeProduto` | carrinho | SIM | reservasPublico |
| POST | `/api/pdv-universal/checkout` | idem | `finalizarCheckout` | checkout UI | SIM | VAS ou MUV |
| POST | `/api/pdv-universal/atendimentos/:id/reservar` | idem | `reservarAtendimentoPdv` | pagamento UI | SIM | MUV |
| POST | `/api/pdv-universal/atendimentos/:id/pagamento` | idem | `confirmarPagamentoPdv` | pagamento UI | SIM | MUV |
| POST | `/api/pdv-universal/atendimentos/:id/cancelar` | idem | `cancelarAtendimentoPdv` | pagamento UI | SIM | MUV |
| POST | `/api/pdv-universal/atendimentos/:id/materializar` | idem | `materializarAtendimentoPdv` | pós-pagamento | SIM | MUV/VAS |
| POST | `/api/pdv-universal/atendimentos/:id/fiscalizar` | idem | `fiscalizarAtendimentoPdv` | pós-pagamento | SIM | fiscal núcleo |
| GET | `/api/pdv-universal/atendimentos/:id/comprovante` | idem | `obterComprovantePdv` | modal | SIM | ComprovanteRenderer |

Nenhuma rota removida.

PDV Normal: `GET /pdv` → `frontend/pdv/index.html`; vendas via `POST /api/vendas` (`pdv.js`), **não** via `/api/pdv-universal`.

## 6. Inventário de services

| Service | Classificação |
|---------|----------------|
| `PDVUniversalContextService` | UNIVERSAL_EXCLUSIVO |
| `PDVUniversalDisponibilidadeService` | UNIVERSAL_EXCLUSIVO |
| `PDVUniversalVendaAdapter` | UNIVERSAL_EXCLUSIVO |
| `PDVUniversalAtendimentoAdapter` | UNIVERSAL_EXCLUSIVO |
| `PDVUniversalApplicationService` | UNIVERSAL_EXCLUSIVO (porta) |
| `VendaApplicationService` | NUCLEO_EMPRESARIAL (Normal também) |
| `reservasPublico` | NUCLEO_EMPRESARIAL |
| Atendimento MUV / materialização | COMPARTILHADO (Universal ME + núcleo MUV) |
| Caixa HTTP | NUCLEO_EMPRESARIAL |
| TEF fluxo compartilhado | COMPARTILHADO (script shared) |

Não movidos. Não duplicados.

## 7. Dependências compartilhadas

Ver secção D. Checkout EMPRESA_UNICA: Universal → `EmpresaUnicaAdapter` → `VendaApplicationService.criarVenda` (mesmo writer do PDV Normal). Checkout MULTIEMPRESA: MUV → materializar.

## 8. Dependências Normal → Universal

**RISCO DE ACOPLAMENTO (navegação, não import JS):**

| Item | Detalhe |
|-------|---------|
| arquivo | `frontend/pdv/index.html` |
| função | link `#nav-abrir-pdv-universal` |
| chamador | operador no PDV Normal |
| motivo | atalho 05.12 |
| impacto | menu aponta para legado congelado |
| estratégia futura | remover item após ERP/dashboard apontarem só `/pdv`; testes 05.12/05.17 ainda exigem o href |

**`frontend/pdv/js/*.js`:** nenhum `require`/`import` de `pdv-universal`. Venda/estoque/pagamento/fiscal do Normal não passam pela porta Universal.

**ERP dashboard** (`dashboard-command.js`): ao abrir módulo `pdv`, navega para Universal. Não é o bundle do Normal, mas é o atalho “PDV” do ERP. Estratégia futura: apontar para `/pdv` numa sprint de navegação (altera produção).

## 9. Dependências Universal → Normal

Nenhum `require` de `frontend/pdv`. Universal não importa `pdv.js`.

Universal → núcleo de vendas (VAS), não o HTML do Normal.

## 10. Infraestrutura

Tabela própria `pdv_universal_*`: **não encontrada**. Persistência em `vendas`, atendimentos MUV, caixa, estoque, fiscal do núcleo.

## 11. Electron / IPC

Sem IPC exclusivo. Janela única; rotas HTTP. Impressão/comprovante: handlers genéricos.

## 12. Testes

Exclusivos: `tests/pdv-universal/` (33).  
PDV Normal: `tests/pdv/` (3).  
Núcleo: vendas/caixa/fiscal/estoque existentes.  
Não apagados.

## 13. Multiempresa no Universal (só identificação)

Já existe (não evoluir):

- `empresa_id` no item/carrinho; `GET/PUT` contexto; `X-Empresa-Id` + `cds_empresa_id`
- disponibilidade por empresa (`reservasPublico`)
- checkout ME via MUV (`itens[].empresaId`)
- caixa UI envia `X-Empresa-Id`
- contexto via `PDVUniversalContextService` / contrato operacional
- **Não** adaptar Universal para novo fluxo multiempresa; evolução no PDV Normal

## 14. Riscos

1. Dashboard ERP ainda trata “PDV” como Universal (`urlPdvUniversalOficial`).
2. Menu do PDV Normal ainda oferece Universal.
3. Testes 05.12/05.17/05.16 exigem href `/pdv-universal/` — não alterar só para “oficializar” o Normal.
4. Nome histórico “PDV legado” = hoje **PDV Normal**.
5. `plugins/smart-dashboard` e `MonitoringActionBuilder` usam `/pdv` (Normal) — inconsistente com dashboard-command.

## 15. Desacoplar futuramente

- Dashboard ERP → `/pdv`
- Remover nav Universal do Normal
- Reduzir testes de navegação que fixam Universal como destino “oficial”
- Nova auditoria completa antes da remoção

## 16. Estratégia de remoção futura

**NÃO remover agora.** Remoção definitiva só após implementação completa do projeto **e** nova auditoria de: dependências, chamadores, rotas, services, frontend, Electron/IPC, testes, integrações, banco, configurações.

Sprint futura sugerida: **REMOÇÃO DEFINITIVA DO PDV UNIVERSAL**.
