# Auditoria de fechamento do Bloco 3 — Operação Pastelaria (Sprint 03.09)

**Tipo:** auditoria. **Produção:** não alterada (exceto artefatos desta sprint: testes e docs).  
**Decisão:** Bloco 3 **PRONTO PARA BLOCO 4 — MIS**. Nenhum P0 conhecido na operação oficial.

Escopo: Pastelaria / CDS. Fora: Açaíteria, cubas, Alô Chefia, cardápio online, iFood — o código da ficha/consumo **não** os incorpora.

---

## 1. Escopo auditado

Sprints 03.01 (fundação multiempresa), 03.02 (POST único), 03.03 (COMERCIAL/INSUMO + ficha), 03.04 (consumo na venda), 03.07 (estorno no cancelamento), 03.08 (estorno proporcional na devolução). Auditorias 03.05/03.06: o P0 de então (ficha sem estorno) foi fechado em 03.07/03.08.

Domínios: multiempresa, produtos, ficha, consumo, venda, estoque, cancelamento, devolução, caixa, financeiro, fiscal NFC-e, compras, Central (somente compatibilidade), PDV Normal vs Universal congelado.

---

## 2. Estado de cada domínio

| Domínio | Estado |
|---------|--------|
| Multiempresa | Isolamento A≠B nos fluxos oficiais |
| Produtos | Catálogo compartilhado; `tipo_operacional` |
| Ficha | Compartilhada; snapshot na venda |
| Consumo | Transação da venda; rollback |
| Venda | POST `/api/vendas` → `VendaPagamentoService` |
| Cancelamento | Crédito comercial + estorno restante da ficha |
| Devolução | `POST .../devolver`; proporcional + teto |
| Estoque | `estoque_empresa` na operação com empresa; dual-write residual |
| Compras | Entrada com ownership; leitor histórico de produto sem `empresa_id` |
| Inventário/perdas | Sem módulo; não obrigatório |
| Caixa | Sessão por `empresa_id`; venda exige caixa da mesma empresa |
| Financeiro | `contas_receber.empresa_id` da venda; `valor_fiscal` / `valor_nao_fiscal` |
| Fiscal | NFC-e + config/certificado por empresa; Plataforma Fiscal aposentada |
| Central | Fechada (05.76); compatível |
| PDV | Normal oficial; Universal CONGELADO |

---

## 3. Multiempresa

Catálogo compartilhado. Estoque, venda, caixa, financeiro e fiscal por `empresa_id`. Ficha compartilhada; **consumo** na empresa da venda.

`EMPRESA_SIMPLES`: várias empresas ativas exigem `empresa_operacional_id`.  
`MULTIEMPRESA`: `empresa_operacional_id = null`; empresa pelo contexto/alvo. Sem fallback empresa 1 / primeira / COMPAT-como-dono no POST oficial.

Matriz 03.09 T11: A consome/devolve/cancela; B permanece intacto.

---

## 4. Produtos

`produtos.tipo_operacional`: `COMERCIAL` | `INSUMO`. Insumo: `INSUMO_NAO_VENDAVEL` no POST; `sqlFiltroProdutoVendavelPdv` na listagem PDV. Sem `empresa_id` na ficha.

---

## 5. Ficha técnica

Cadastro `GET/PUT /api/produtos/:id/ficha-tecnica`. Ativa só em comercial. Snapshot em `venda_ficha_consumo` / `_itens`. Alterar ficha depois da venda não recalcula histórico (T12: 80 g vs ficha 120 g).

---

## 6. Consumo

`qtd vendida × ficha`, conversão `MotorUnidadesMedida`, débito do insumo com `exigirEmpresa: true`. Pré-checagem em `consultarSaldo` + `estoque_empresa`. Na mesma `BEGIN` da venda; falha → `ROLLBACK`; sem baixa parcial.

---

## 7. Venda

```
PDV Normal (/pdv) → POST /api/vendas → VendaApplicationService
  → VendaPagamentoService → vendas.empresa_id
  → baixa comercial → consumirFichaTecnicaDaVenda
```

MULTIEMPRESA sem empresa: bloqueio (`exigirEmpresaDaOperacao`). Caixa da venda = empresa da venda (`exigirCaixaCompativelComVenda`).

---

## 8. Cancelamento (03.07)

`PUT /api/vendas/:id/cancelar` e `POST /api/vendas/cancelar/:id` → `devolverEstoqueEEstornarFichaDaVenda` na `BEGIN IMMEDIATE`: crédito comercial, estorno de **restante** da ficha (após devoluções), depois `cancelada`. Snapshot. `estornado_em` idempotente. Falha → rollback.

---

## 9. Devolução (03.08)

Oficial: `POST /api/vendas/:id/devolver` → `devolverParcial`.  
Fórmula: `snapshot × qtd_devolvida / qtd_vendida`. Teto `venda_ficha_consumo_estornos` ≤ snapshot. Idempotência `(venda_devolucao_id, insumo_id)`. Sucessivas e total cobertas. Mesma devolução não duplica. Cancelamento posterior só o restante (T10).

Rotas `nfe-devolucao`: fiscais; não são o estorno da ficha.

---

## 10. Estoque

Entrada (compras/Central) e saída (venda/consumo) com `empresa_id` nos writers oficiais. Unidade/conversão na ficha. Sem motor novo. Dual-write: ver §20.

---

## 11. Compras

Compra e vínculo Central isolados (05.56/05.59). Atualização de estoque via porta com contexto da compra.

**Leitor D — `GET /api/produtos/:id/ultimas-compras`:** JOIN `compras` **sem** `c.empresa_id`. Não muta estoque. Afeta **consulta** no cadastro do produto (histórico pode misturar CNPJs). Classificação: **P1 consulta** / não bloqueia operação de venda.

`GET /:id/historico-estoque`: `produtos_ajustes_estoque` sem filtro de empresa — mesmo perfil.

---

## 12. Inventário e perdas

Não existe módulo de inventário/contagem física. Ajustes pontuais: `ajusteEstoqueService` (COMPAT se JWT sem empresa). **FORA DO FECHAMENTO** para o Bloco 3: a Pastelaria opera com compras + venda + ficha; perda sistemática não é P0 até o cliente exigir conferência periódica.

---

## 13. Caixa

Abertura/sangria/fechamento com `anexarEmpresaCaixa`. Venda PDV exige sessão aberta da **mesma** empresa. Sem lançar caixa B a partir de venda A (03.01 T09–T10, 03.02 T13–T15).

---

## 14. Financeiro

`contas_receber.empresa_id` = empresa da venda. Recebimentos no fluxo de pagamento. Cancelamento/devolução usam serviços existentes; `valor_fiscal` / `valor_nao_fiscal` na venda. PUT vs POST de cancelamento ainda diferem em um INSERT extra de `financeiro` (conhecido 03.06) — **P2**, não impede operar.

---

## 15. Fiscal

NFC-e: `POST /api/fiscal/emitir/venda/:vendaId` + `anexarEmpresaFiscal`. Config e certificado por empresa. NF-e 55 (telas `nfe-*`) existe no ERP mas **não** é critério de fechamento da Pastelaria. Aposentadoria da Plataforma Fiscal (05.80) não removeu NFC-e nem config empresarial.

---

## 16. Central

Fechada 05.76. Documentos, compras, empresas e config fiscal continuam isolados (regressões 05.54–05.77). Sem nova sprint visual.

---

## 17. PDV

**Oficial:** PDV Normal (`/pdv`, `frontend/pdv/js/pdv.js` → `POST /api/vendas`).  
**Universal:** `CONGELADO`. Rotas `/api/pdv-universal/*` e menu verde “Abrir PDV Universal” **permanecem**. EMPRESA_SIMPLES no Universal ainda pode cair em `VendaApplicationService.criarVenda`; MULTIEMPRESA no Universal pode usar MUV `criarAtendimento` (fora do núcleo 03.02). **Não evoluir / não remover nesta fase.** Homologação: treinar `/pdv`.

---

## 18. Telas

| Tela | Classificação |
|------|----------------|
| Empresas | PRONTA (Centro / `gestao-empresas-fiscal.js`) |
| Produtos + tipo + ficha | PRONTA (`produtos.js`) |
| PDV Normal | PRONTA (`/pdv`) |
| PDV Universal | LEGADA / BLOQUEADA para evolução |
| Caixa | PRONTA |
| Financeiro | PRONTA |
| Fiscal NFC-e | PRONTA (`fiscal.js`) |
| Central de Entradas | PRONTA (fechada) |
| Compras | PRONTA |
| Inventário | FALTANTE (fora do fechamento) |
| Menu “PDV legado” vs Universal verde | PARCIAL (UX: rótulo invertido em relação à política oficial) |

---

## 19. APIs (amostra)

| API | Classe |
|-----|--------|
| `POST /api/vendas` | oficial |
| `PUT /api/vendas/:id/cancelar` | oficial |
| `POST /api/vendas/cancelar/:id` | oficial (duplicado de canal) |
| `POST /api/vendas/:id/devolver` | oficial |
| `GET/PUT /api/produtos/:id/ficha-tecnica` | oficial |
| `GET /api/produtos/:id/ultimas-compras` | risco leitura (D) |
| `GET /api/vendas/relatorio/produtos-mais-vendidos` | ranking sem `v.empresa_id` — MIS |
| `/api/pdv-universal/*` | legado congelado |
| `*/nfe-devolucao*` | fiscal; não estorna ficha |
| Central `/api/central-entradas/*` | oficial fechada |

Nenhuma remoção nesta sprint.

---

## 20. Riscos

**Dual-write `produtos` × `estoque_empresa`:** writers (`debitarSaldo`/`creditarSaldo`) leem e atualizam o piso **global** em `produtos` e depois espelham `estoque_empresa` se houver `empresaId`. A consulta pública com empresa lê **só** `estoque_empresa`. Consumo de ficha pré-valida EE, depois debita a porta. Risco real em **MULTIEMPRESA com o mesmo SKU em duas lojas**: falso `SALDO_INSUFICIENTE` no global ou descompasso se o piso global não for a soma. **Não cruza** estoque B no espelho (só `ctx.empresaId`). Não é P0 de cruzamento; é **P1** operacional. Em Pastelaria típica `EMPRESA_SIMPLES` com uma empresa operacional, impacto atual baixo (**risco aceitável** nesse recorte).

---

## 21. P0

Nenhum.

---

## 22. P1

1. Dual-write (piso `produtos` vs `estoque_empresa`) em operação com duas+ empresas no mesmo SKU.  
2. `ultimas-compras` / `historico-estoque` sem filtro de empresa (consulta).  
3. Menu ERP destaca PDV Universal; o oficial aparece como “legado” — risco de usar caminho congelado.  
4. `ajusteEstoqueService` COMPAT sem empresa no JWT (não é o POST do PDV).

Não impedem apresentar/operar a Pastelaria no PDV Normal com empresa correta.

---

## 23. P2

Inventário/perdas; ranking de produtos sem `empresa_id` (Bloco 4); divergência PUT/POST no extra financeiro do cancelamento; split F/NF não persistido no snapshot da ficha; pane oculta `plataformaFiscalRuntime`; NF-e 55 no menu.

---

## 24. Riscos aceitáveis

Dual-write no recorte **uma empresa operacional**. Leitor D de compras como tela de histórico. Universal residual até auditoria de remoção. Central fechada com débito visual conhecido (05.77).

---

## 25. Fora do escopo

Açaíteria, cubas, iFood, Alô Chefia, cardápio, Open Finance, MIS (Bloco 4), evolução da Central, evolução/remoção do Universal, NF-e 55 como requisito Pastelaria.

---

## 26. Conclusão do Bloco 3

O cliente **consegue operar a Pastelaria com segurança** no fluxo oficial:

empresa → produto → ficha → estoque da empresa → venda PDV Normal → consumo (snapshot) → devolução/cancelamento → estorno ≤ consumo → caixa / financeiro / NFC-e.

Invariantes `empresa_id`, snapshot e A ≠ B validados (03.09 T10–T14 + regressões). **Bloco 3 fechado para homologação. Próximo: BLOCO 4 — MIS.** Não iniciar implementação do Bloco 4 nesta sprint.
