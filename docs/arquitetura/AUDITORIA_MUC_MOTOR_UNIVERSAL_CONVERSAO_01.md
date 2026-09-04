# Auditoria MUC-01 — Motor Universal de Conversão

**Tipo:** auditoria. **Produção:** não alterada (exceto artefatos desta sprint: `tests/muc/auditoria-muc-01.test.js` e estes docs).  
**Decisão:** MUC **PARCIAL** — apto para evolução controlada, **não** reconstruir. Não é ainda o único conversor do ERP.

---

## 1. Definição atual do MUC

Existe um **Motor Universal de Conversão (MUC) RC2.1**, com arquitetura declarada congelada (`backend/motores/muc/version.js`: `ARQUITETURA_CONGELADA`). A fachada oficial é `obterMuc(db)` (`backend/motores/muc/index.js` / `public.js`).

O que o MUC **faz de fato** no cálculo:

- transforma **quantidade de compra × fator da apresentação** (embalagem) na **quantidade de estoque**;
- persiste metadados (`fator_conversao`, `resultado_conversao_json`, auditoria);
- infere tipo de apresentação (CX, FD, UN…) e rótulos de regra (PESO, VOLUME…).

O que o MUC **não faz** no cálculo:

- **não** aplica SI (L↔ml, kg↔g) na etapa de cálculo;
- **não** encadeia CAIXA → UN → ml numa única chamada;
- **não** escolhe empresa nem movimenta estoque.

Há **três camadas** que o código chama de conversão:

| Camada | Papel real |
|--------|------------|
| `backend/motores/muc/` | Pipeline, DTOs, apresentações, auditoria, compras |
| `backend/lib/motorConversaoUnidades.js` | Legado: `qtd embalagens × quantidade_por_embalagem` — **o MUC calcula por cima disto** |
| `backend/services/unidades/MotorUnidadesMedida.js` | Catálogo comercial + **SI** (`converterQuantidadeEntreUnidades`) + formação de preço |

**Conclusão:** o MUC existe como motor de **compra/embalagem**. Não é o motor único do ERP. Ficha/consumo usam **MotorUnidadesMedida**, não `obterMuc`.

---

## 2. Arquivos

**Núcleo MUC** (`backend/motores/muc/`): `index.js`, `public.js`, `version.js`, `pipeline/PipelineMuc.js`, `core/` (Parser, Validação, Normalização, Inferência, `MotorConversao`, `MotorConversaoCalculo`, `ParserApresentacoes`, auditoria etapa), `dto/`, `constants/` (`catalogoRegras`, `tiposApresentacao`, `tiposConversao`), `schema/mucSchema.js`, `repositorios/`, `auditoria/`, `aprendizado/`, `cache/`, `eventos/`, `observabilidade/`.

**Cálculo legado:** `backend/lib/motorConversaoUnidades.js`.

**SI / cadastro comercial:** `backend/services/unidades/MotorUnidadesMedida.js`.

**Apresentações:** `backend/services/produto-embalagem/ProdutoEmbalagemService.js`, `produtoEmbalagensSchema.js`.

**Consumidores Pastelaria:** `backend/rotas/compras.js`, `backend/services/produtos/FichaTecnicaService.js` (apenas `MotorConversao.converter` exportado, **não** usado em `salvar`), `backend/services/produtos/FichaTecnicaConsumoService.js` (MotorUM).

**Importação (fator próprio):** `backend/services/importacao-inicial-produtos/`.

---

## 3. Classes / módulos

- `MotorUniversalConversao` — facade (`obterMuc`).
- `PipelineMuc.executar` — Parser → Validação → Normalização → Inferência → `MotorConversaoCalculo` → auditoria.
- `MotorConversao` — compat RC1; `simularConversao` chama legado.
- `MotorInferencia.inferirConversao` — fator = `apresentacao.quantidade`; tipo UN força fator 1.
- `RepositorioApresentacoes` / `RepositorioHistorico`.
- `AuditoriaConversao`, `MotorAprendizado`, `MotorCacheConversao`.
- Não há model ORM: SQLite via `db.run` / `db.get`.

---

## 4. Services

| Service | Conversão |
|---------|-----------|
| `obterMuc` / `processarItemCompra` | Oficial em **compras** |
| `MotorUnidadesMedida` | Oficial em **ficha consumo** e cadastro `unidade_comercial` |
| `ProdutoEmbalagemService` | CRUD apresentação; `fator_conversao` = `quantidade` da embalagem |
| `FichaTecnicaService` | Valida unidade com MotorUM; **não** converte no save |
| `FichaTecnicaConsumoService` | `converterQuantidadeEntreUnidades` + `round3` |
| `creditoEstoqueCompraViaPorta` | Credita quantidade **já convertida** pelo item; não chama MUC |
| Importação inicial | `quantidade_origem * fator_conversao` — **fora do MUC** |

---

## 5. APIs

| Método | Rota | Service | Finalidade | Consumidor |
|--------|------|---------|------------|------------|
| POST | `/api/compras` | `obterMuc.processarItemCompra` | Conversão na entrada | Compras / Central |
| POST | `/api/compras/simular-conversao-muc` | `muc.simular` | Simular CX×fator, sem persistir | UI compras |
| GET | `/api/produtos/:id/embalagens` | `ProdutoEmbalagemService` | Listar apresentações | Cadastro |
| GET | `/api/produtos/:produtoId/embalagens/:embId/historico` | idem | Histórico | Cadastro |
| POST | `/api/produtos/:id/embalagens/aprendizagem-compra` | aprendizagem UC | Aprender apresentação na compra | Compras |
| POST/PUT | `/api/produtos` | MotorUM no body | `compra_por_embalagem`, `unidade_comercial`, `quantidade_por_embalagem` | Cadastro |
| GET/PUT | `/api/produtos/:id/ficha-tecnica` | `FichaTecnicaService` | Quantidade+unidade da receita, sem SI | Cadastro |
| POST | `/api/vendas` | consumo ficha | MotorUM na transação | PDV Normal |

Não há API REST “converter SI” isolada. PDV Universal: **não auditado para alteração**; não consome `obterMuc` no fluxo de ficha.

---

## 6. Tabelas

| Tabela | Colunas relevantes | Relação |
|--------|--------------------|---------|
| `produtos` | `unidade`, `unidade_comercial`, `quantidade_por_embalagem`, `compra_por_embalagem`, `valor_compra_embalagem`, `produto_fracionado`, `tipo_operacional` | Catálogo compartilhado |
| `produto_embalagens` | `tipo`, `quantidade`, `unidade`, `compra`/`venda`/`estoque`, `tipo_conversao`, flags | N apresentações / produto |
| `produto_embalagem_historico` | campo, valores | Auditoria apresentação |
| `compras_itens` | `embalagem_id`, `produto_apresentacao_id`, `fator_conversao`, `tipo_conversao`, `resultado_conversao_json`, `quantidade_por_embalagem` | Item de compra |
| `muc_auditoria_conversao` | fator, qtd compra/estoque, hash, regra | Log MUC |
| `muc_aprendizado` | fator por fornecedor/GTIN/produto | Aprendizado |
| `ficha_tecnica` / `ficha_tecnica_itens` | `quantidade`, `unidade` | Receita compartilhada |
| `venda_ficha_consumo` / `_itens` | `quantidade`+`unidade` (estoque), `quantidade_ficha`+`unidade_ficha` | Snapshot |
| `venda_ficha_consumo_estornos` | `quantidade`, `unidade` | Estorno |
| Estoque | saldos por produto/`empresa_id` | Não guarda fator MUC |

Não existe coluna `unidade_base` nem flag `utiliza_conversao` genérica. Aproximações: `compra_por_embalagem`, `produto_fracionado`.

---

## 7. Unidades

Catálogo MotorUM: UN, PACOTE, CAIXA, FARDO, SACO, LATA, BALDE, ROLO, BARRA, KIT, DISPLAY, BOBINA, GALAO, KG, G, L, ML, M, CM, M2, M3.

Famílias SI (`FATOR_UNIDADE_BASE`): MASSA (G=0,001 / KG=1), VOLUME (ML=0,001 / L=1), COMPRIMENTO (CM/M), UN.

**Unidade de estoque** = `produtos.unidade` (e `apresentacao.unidade` no MUC, em minúsculas). Não há “unidade base ml” separada da unidade de cadastro.

MUC `unidadeEstoque` vem da apresentação ou default `'un'` — **rótulo**, não conversão SI.

---

## 8. Conversões

**Oficial MUC (runtime compra):** `quantidade_embalagens × fator` → estoque na unidade do produto.

**Oficial MotorUM (runtime ficha):** `(qtd × fatorOrigem) / fatorDestino` na mesma família; inverso kg↔g e L↔ml.

**Persistida:** fator no item de compra e na apresentação; ficha grava quantidade+unidade da receita **sem** quantidade já convertida; snapshot de consumo grava **já convertida** para estoque.

**Catálogo MUC PESO/VOLUME/DIVISOR:** inferência de **tipo**; o cálculo legado **sempre multiplica**. VOLUME não executa L→ml.

---

## 9. Embalagens

`produto_embalagens.quantidade` = conteúdo da apresentação na `unidade` da linha (ex.: 12 UN).

**1 CAIXA = 12 UN:** sim, um fator.

**1 UN = 2.000 ml:** só se a unidade de estoque do produto já for ml **e** o fator da apresentação for 2000 (1 CX = 2000 ml) **ou** se o cadastro for UN de venda com `unidade` = ml e fator 2000 na apresentação UN — **não** duas relações encadeadas no motor.

Encadeamento CX→UN→ml: **não suportado** pelo MUC sozinho.

---

## 10. Compras

Fluxo: item → `obterMuc.processarItemCompra` → quantidade convertida no item → crédito de estoque na **empresa da compra**.

**12 caixas de Coca 2 L → 24.000 ml automaticamente?** **NÃO.**

Motivo: 12 × 12 = **144** (se fator = 12 UN/caixa). A unidade de estoque permanece a do produto (em geral UN). Não há segunda etapa 144 UN × 2000 ml.

**PARCIAL** apenas se o cadastro mentir o fator (ex.: 1 caixa = 24.000 já em ml) — um único multiplicador, não o modelo funcional proposto.

---

## 11. Estoque

Armazena **número + unidade do produto**. Conversão ocorre **antes** da movimentação (compra: MUC; venda ficha: MotorUM). Consultas não reconvertem.

Arquitetura mais segura para a proposta Pastelaria: **compra → MUC (incluindo SI encadeado) → quantidade na unidade de estoque → movimentação com `empresa_id`**. Unidade intermediária persistida só se o snapshot de compra precisar auditar a UC; o saldo deve ser uma unidade.

---

## 12. Ficha técnica

Itens: `insumo_id`, `quantidade`, `unidade` (validada MotorUM). Cadastro **não** chama MUC. `converterQuantidadeFicha` existe e delega `MotorConversao.converter` (pipeline de **compra**), e **não** é usado em `salvar`.

---

## 13. Consumo

`qtd vendida × quantidade_ficha` → `MotorUM.converterQuantidadeEntreUnidades(ficha → produtos.unidade do insumo)` → `round3` → débito. 300 ml → L de estoque = 0,3 L. Famílias diferentes: `CONVERSAO_INVALIDA` (não inventa).

---

## 14. Cancelamento (03.07)

`estornarConsumoFichaTecnicaDaVenda` lê `venda_ficha_consumo_itens.quantidade` / `unidade` (já em estoque). **Não** relê ficha nem MotorUM/MUC.

---

## 15. Devolução (03.08)

Proporcional sobre o mesmo snapshot; teto; idempotência. Mesma unidade do consumo.

---

## 16. Snapshot

`venda_ficha_consumo_itens`: `quantidade` + `unidade` (estoque), `quantidade_ficha` + `unidade_ficha`. **Sem** `fator` explícito. Suficiente para estorno **enquanto** a unidade de estoque do movimento for a gravada. Se o cadastro do insumo mudar de KG para G depois, o histórico **não** é reescrito (já coberto em 03.09). Não há fator MUC no snapshot — não precisa, porque a quantidade de estoque já está convertida.

---

## 17. Multiempresa

Conversão estrutural: **produto / apresentação / ficha** — compartilhada.  
Estoque convertido: **empresa da movimentação**.  
MUC e MotorUM **não** recebem `empresa_id` no cálculo.

Empresa A 12 UN e Empresa B 6 UN usam a **mesma** definição; saldos A≠B.

---

## 18. Conversões encadeadas

**Não suportado** no MUC. **Parcial** se o chamador fizer MUC e depois MotorUM (hoje **ninguém** faz isso na compra). Inferência VOLUME com unidade ml **não** encadeia.

---

## 19. Precisão

| Ponto | Padrão |
|-------|--------|
| MotorUM SI | `num(..., 6)` |
| MotorUM embalagem / MUC DTO | 4 casas |
| Moeda legado | 2 casas; custo unitário 4 |
| Consumo ficha | `round3` (3 casas) após SI |
| SQLite | REAL |

Casos 0,333 kg→g, 1,5 L→ml, 125 ml→L, 37,5 g→kg: cobertos no MotorUM (T06).

Risco aceitável: 6 vs 3 casas entre SI e débito.

---

## 20. Hardcodes

| Ocorrência | Classe |
|------------|--------|
| `FATOR_UNIDADE_BASE` 0,001 | Utilitário SI legítimo (MotorUM) |
| Catálogo MUC VOLUME/PESO | Rótulo; cálculo não aplica SI |
| `obterQuantidadeConvertida` × fator | MUC/legado oficial |
| Importação `fator_conversao` | Regra específica de importação |
| Toledo `payloadNum / 1000` | Equipamento (peso), não MUC |
| `* 1000 / 1000` em estoque | Arredondamento 3 casas, não unidade |

Nenhum hard-code L=1000 ml **dentro** do MUC de compra.

---

## 21. Testes

Existentes: `tests/muc/muc-public-contract.test.js`, `muc-rc1-certificacao.test.js`, `muc-rc2-certificacao.test.js`, `rc431-build-certificacao.test.js`; compras RC4.31.12*; `tests/compras/rc840-unidades-isolamento.test.js`, `rc842-compra-por-embalagem.test.js`; ficha 03.03/03.04/03.07/03.08.

Suíte desta sprint: `tests/muc/auditoria-muc-01.test.js` (T00–T12). T05 **documenta a lacuna** de encadeamento (144 ≠ 24000).

---

## 22. P0

Nenhum P0 comprovado no caminho **ficha → consumo SI → snapshot → estorno**, quando origem e estoque são da **mesma família**.

**P0 latente (modelo Coca sem sprint de encadeamento):** persistir estoque em ml e comprar só CX×UN gera saldo **errado** (144 UN vs 24.000 ml) se alguém gravar `unidade=ml` sem fator 2000. Bloqueia o modelo funcional da sprint **até** o MUC (ou um único consumidor) encadear. Não é falha do consumo atual de carne em g/kg.

---

## 23. P1

- Dois motores oficiais (MUC compra vs MotorUM ficha).
- Encadeamento CX→UN→ml ausente.
- Regras PESO/VOLUME/DIVISOR no catálogo **não** alteram a fórmula (sempre multiplicar).
- `converterQuantidadeFicha` aponta para pipeline de compra e não é o caminho da ficha.
- Importação inicial com fator paralelo.
- Sem flag `utiliza conversão` / unidade base explícita.
- Compra→estoque Coca/água no modelo proposto: **não** automático.

---

## 24. P2

- Unificar entrada pública (`obterMuc.converterSi` ou etapa SI no pipeline).
- Persistir fator no snapshot de ficha (redundante hoje).
- Alinhar precisão 6 vs 3.
- API REST de conversão SI para UI.

---

## 25. Riscos aceitáveis

- Dual-write de estoque (já 03.09 P1).
- `round3` após SI.
- Default `'un'` no MUC se apresentação sem unidade.
- PDV Universal congelado fora deste motor.

---

## 26. Lacunas (o que realmente precisa ser implementado — sprints futuras)

1. **Uma** API de conversão: embalagem **e** SI, encadeável.  
2. Cadastro: unidade de estoque + relações (CX→UN, UN→ml) **ou** fator único equivalente.  
3. Compras e ficha **somente** consumidores.  
4. Não misturar importação com fórmula ad hoc sem passar no mesmo motor.  
5. Pastel Especial: consumo variável — fora do MUC atual.

**Não** nesta sprint: produtos, tipo_operacional, compras, estoque, ficha, PDV, MIS, Central, schema.

---

## 27. Arquitetura recomendada

```
                    MUC (único)
         qtd + unidade origem → qtd + unidade destino
         (fator embalagem + SI, encadeado, inversível na família)
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 Compras    Ficha     (consultas)
    │         │
    └─────────┼─────────┘
              ▼
     Estoque / empresa_id  (não é o MUC)
```

Evitar conversor próprio em compras, ficha, PDV e estoque.

Preferir **compra → conversão completa → unidade de estoque** a uma unidade intermediária persistida no saldo.

---

## 28. Proposta para a Pastelaria (não implementar agora)

**COMERCIAL** com conversão (Coca 2 L, água 350 ml): o cadastro atual **permite** vender UN e ter `unidade` de estoque SI **se** o fator único for gravado (ex. estoque em ml e 1 CX = 24.000). O modelo **explícito** 12 UN × 2.000 ml **não** está no MUC.

**INSUMO** (laranja, carne, massa, queijo): `tipo_operacional=INSUMO` + ficha em g/ml + MotorUM **já** cobre SI se o estoque for kg/L da mesma família. Conversão de **compra** do insumo em fardo/caixa é o mesmo limite MUC (um fator).

**Pastel Especial:** MUC só converteria cada linha (X g, Y ml, Z UN). Escolha variável (6 de 42) é regra de **venda/ficha dinâmica**, não do motor.

---

## 29. Dependências futuras

- Sprint mínima sugerida: **MUC-02** — etapa SI + encadeamento no pipeline (sem mudar telas), testes Coca/água; depois compras/ficha passarem a chamar só `obterMuc`.  
- Pastel Especial depois da classificação comercial/insumo estável.  
- Não puxar MIS, Central, PDV Universal, Open Finance.

---

## Matriz de módulos

| Módulo | Usa MUC (`obterMuc`)? | Função | Unidade | Origem→destino | Persistida? | Própria? |
|--------|----------------------|--------|---------|----------------|-------------|----------|
| Produtos | Não (MotorUM cadastro) | normalizar UC | comercial | cadastro | sim campos produto | MotorUM |
| Compras | **Sim** | `processarItemCompra` | UC → `unidade` produto | runtime + JSON item | sim fator | legado sob o MUC |
| Estoque | Não | credita qtd pronta | estoque | — | saldo | não |
| Ficha cadastro | Não (export morto) | validar unidade | receita | — | qtd+un | — |
| Ficha consumo | **Não** | MotorUM SI | ficha→estoque | runtime | snapshot convertido | MotorUM |
| PDV | Não direto | via venda/consumo | — | — | — | — |
| Devolução/cancel. | Não | snapshot | estoque | — | sim | — |
| Inventário | Sem módulo Pastelaria | — | — | — | — | — |
| Relatórios/MIS | Não | — | — | — | — | — |

---

## Respostas do critério de conclusão

| Pergunta | Resposta |
|----------|----------|
| O MUC existe? | **SIM**, RC2.1, parcial como motor único |
| Onde? | `backend/motores/muc/` + cálculo em `lib/motorConversaoUnidades.js` |
| Como funciona? | Pipeline; estoque = compra × fator apresentação |
| Quem usa? | Principalmente `rotas/compras.js` |
| Conversão fora? | MotorUM (ficha), importação, formação de preço, legado `obterQuantidadeConvertida` direto em compras em trechos |
| Compra convertida? | Sim, um hop embalagem |
| Estoque armazena? | Quantidade na `unidade` do produto, por empresa na movimentação |
| Ficha consome? | MotorUM SI + round3 |
| Estorno? | Snapshot, mesma unidade |
| Snapshot suficiente? | Sim para 03.07/03.08 |
| Encadeadas? | Não no MUC |
| Precisão segura? | Sim para SI 6 casas; round3 no débito |
| Multiempresa isolada? | Conversão compartilhada; estoque não |
| Coca 2L / água 350ml? | Não no modelo 12×2000 encadeado; sim com fator único se cadastro for ml |
| Laranja / carne / massa / queijo? | SI na ficha sim; compra em embalagem = um fator |
| Pastel Especial? | Dependência futura; MUC só converteria linhas fixas |
