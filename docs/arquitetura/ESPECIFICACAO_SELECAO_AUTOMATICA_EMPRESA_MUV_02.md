# AUD/SPEC-MUV-02 — Especificação da política de seleção automática da empresa

**Tipo:** especificação técnica e validação documental (somente leitura no código de produção)  
**Data:** 2026-10-26  
**Pré-requisito:** `docs/auditorias/AUD-MUV-01-RELATORIO.md`  
**Homologação:** pendente (Tech Lead / Product Owner nas decisões marcadas)  
**Escopo de implementação nesta sprint:** nenhum

---

## 1. Objetivo e regras de negócio

### 1.1 Objetivo

Definir o contrato técnico verificável da política que, no **PDV oficial** (`/pdv`), selecionará **automaticamente uma única empresa** capaz de atender **integralmente** o carrinho, priorizando a **matriz** e considerando **estoque por empresa** e **ficha técnica**, sem dividir a venda entre CNPJs.

Esta especificação **não implementa** o seletor nem o serviço de capacidade.

### 1.2 Regras de negócio (Product Owner) — obrigatórias

| # | Regra |
|---|---|
| R1 | Catálogo de produtos pode ser compartilhado entre empresas. |
| R2 | Estoque, custos, saldos e dados fiscais são específicos por empresa. |
| R3 | O sistema seleciona automaticamente a empresa da venda; o operador **não** escolhe empresa por item. |
| R4 | A matriz tem prioridade quando consegue atender o pedido completo. |
| R5 | Se a matriz não atender, avalia-se as demais empresas elegíveis por política determinística documentada. |
| R6 | A empresa escolhida deve atender **todos** os itens e quantidades (estoque + fichas). |
| R7 | A venda inteira pertence a uma única empresa / um único CNPJ emissor. |
| R8 | Estoques de empresas distintas **não** podem ser somados para declarar atendimento. |
| R9 | É proibido dividir silenciosamente itens, ingredientes ou quantidades entre empresas. |
| R10 | Se nenhuma empresa atender o pedido inteiro, a finalização é **bloqueada** com mensagem clara; não se cria venda parcial. |

### 1.3 Premissas arquiteturais confirmadas (AUD-MUV-01 + docs 03.01 / 03.02)

| Premissa | Evidência |
|---|---|
| PDV oficial = `/pdv` | `pdv-acesso-oficial.js`, menu ERP, `PDV_NORMAL_MULTIEMPRESA_PASTELARIA_03_01.md` |
| Finalização oficial = `POST /api/vendas` → `VendaPagamentoService` | `PDV_NORMAL_VENDA_PAGAMENTO_MULTIEMPRESA_03_02.md`, `VendaApplicationService` |
| Empresa hoje = contexto (`X-Empresa-Id`), sem seletor por capacidade | AUD-MUV-01 |
| Uma venda → um `vendas.empresa_id` no caminho oficial | 03.01 / 03.02 |
| PDV Universal / MUV multi-operação **não** são o caminho oficial desta regra | AUD-MUV-01, `PDV_UNIVERSAL_CONGELADO.md` |
| Matriz identificável por CNPJ ordem `0001` | `ContextoEmpresaOperacionalService.classificarTipoEmpresa` / `escolherMatrizPadrao` |
| Disponibilidade por empresa: `estoque_empresa` + reservas | `reservasPublico.consultarDisponibilidade` |
| Ficha: consumo pós-empresa definida | `FichaTecnicaConsumoService` |

---

## 2. Fluxo conceitual da seleção

```
Carrinho (itens sem empresa por linha)
        │
        ▼
┌───────────────────────────────┐
│ 1. Montar conjunto elegível   │  ativas + autorizadas ao usuário
│    + identificar MATRIZ       │  (+ regras fiscais/elegibilidade)
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ 2. Avaliar CAPACIDADE         │  por empresa, carrinho inteiro
│    (consulta somente leitura) │  estoque + ficha; SEM somar empresas
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ 3. Aplicar POLÍTICA           │  matriz se atende; senão 1ª filial
│    (ordem determinística)     │  capaz; senão BLOQUEAR
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ 4. Fixar empresa_selecionada  │  snapshot + hash do carrinho
│    (ainda NÃO é garantia)     │
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ 5. Finalização                │  revalidar capacidade +
│    POST /api/vendas           │  reservar/debitar na MESMA empresa
└───────────────────────────────┘
```

**Separação obrigatória:** consulta de capacidade ≠ reserva/baixa. A consulta **não** autoriza consumir estoque indisponível se o saldo mudar antes da finalização.

---

## 3. Política de prioridade matriz → filiais

### 3.1 Identificação da matriz

**Decisão proposta (alinhada ao código existente):**

1. Empresa **ativa** (`ativo = 1`) cujo CNPJ (14 dígitos) tem ordem **0001** (posições 9–12) → tipo `MATRIZ` (`classificarTipoEmpresa`).
2. Se existir **exatamente uma** matriz ativa elegível → essa é a matriz candidata prioritária.
3. Se existirem **várias** matrizes ativas → aplicar o desempate já usado no contexto operacional: `empresa_operacional_id` configurado (`escolherMatrizPadrao` / origem `MATRIZ_EMPRESA_OPERACIONAL_ID`).
4. Se ambiguidade persistir (`MATRIZ_AMBIGUA`) ou não houver matriz (`MATRIZ_AUSENTE`) → **não inventar** matriz: ver decisão pendente **P-01**.

### 3.2 Conjunto de empresas elegíveis

Uma empresa entra no conjunto elegível somente se **todas** as condições abaixo forem verdadeiras:

| # | Condição | Fonte arquitetural |
|---|---|---|
| E1 | `ativo = 1` | cadastro `empresas` |
| E2 | Usuário autenticado **pode acessar** a empresa | `UsuarioEmpresaService` / `listarEmpresasPermitidas` |
| E3 | Empresa participa do modo MULTIEmpresa relevante (modo global MULTIEMPRESA) | `modo-operacional` |
| E4 | Produtos do carrinho existem no catálogo compartilhado (produto compartilhado; sem `produto_empresa` como filtro de PDV) | 03.01 |
| E5 | Capacidade do carrinho = **atende integralmente** (seção 5) | futuro serviço de capacidade |

**Fiscal (elegibilidade adicional):**

| Situação | Tratamento proposto |
|---|---|
| Venda **sem** emissão fiscal imediata | Empresa elegível mesmo sem certificado completo (**pendente P-02** se o PO exigir fiscal sempre) |
| Venda **com** emissão NFC-e / fiscal obrigatório no fluxo | Empresa **inelegível** se contexto fiscal da empresa estiver inválido (`FISCAL_NAO_CONFIGURADO`, certificado ausente, etc., conforme `ContextoEmpresaOperacionalService`) |

### 3.3 Ordem de avaliação

**Algoritmo determinístico proposto:**

1. Avaliar a **matriz** (seção 3.1) primeiro, se estiver no conjunto elegível e for capaz.
2. Se a matriz **atender integralmente** → **selecioná-la** (parar).
3. Caso contrário, avaliar **filiais elegíveis** na ordem:
   - **Proposta técnica (determinística, reutiliza chave estável):** `ORDER BY empresas.id ASC` entre as filiais (`tipo = FILIAL`) que passam E1–E5.
4. Selecionar a **primeira** filial cuja capacidade `atende = true`.
5. Se nenhuma atender → **bloquear** (R10).

### 3.4 Empates

| Caso | Tratamento |
|---|---|
| Matriz e filiais todas capazes | Matriz vence (R4); filiais nem precisam ser escolhidas se a matriz passou |
| Várias filiais capazes | Primeira na ordem da seção 3.3 (menor `id`) |
| Duas matrizes capazes / ambíguas | Resolver via `empresa_operacional_id`; se ainda ambíguo → **P-01** |

**Não usar** estoque “maior” como desempate nesta versão, salvo aprovação explícita do PO (**P-03**).

### 3.5 Inativas, produtos indisponíveis, fiscal inválido

| Situação | Resultado |
|---|---|
| Empresa inativa | Fora do conjunto elegível |
| Produto inexistente / inativo no catálogo | Carrinho inválido → bloquear finalização (erro de catálogo, não de seleção) |
| Produto sem controle de estoque (`controla_estoque = 0`) | Não limita capacidade por saldo desse SKU; demais itens/fichas continuam valendo (`produtoControlaEstoque`) |
| Empresa sem config fiscal e fluxo exige NFC-e | Inelegível para esse carrinho/fluxo |
| Usuário sem vínculo com a empresa | Inelegível (mesmo que tenha estoque) |

---

## 4. Decisões definidas e decisões pendentes

### 4.1 Decisões definidas nesta especificação (propostas para homologação)

| ID | Decisão |
|---|---|
| D-01 | Escopo = PDV oficial `/pdv` → `POST /api/vendas`; Universal/MUV multi-operação **fora** do caminho oficial desta política. |
| D-02 | Seleção é **automática** e por **carrinho inteiro**; proibido escolha por item e split silencioso. |
| D-03 | Matriz = CNPJ ordem `0001`, reutilizando `classificarTipoEmpresa` / `escolherMatrizPadrao`. |
| D-04 | Ordem de filiais candidatas (versão 1): `empresas.id ASC`. |
| D-05 | Capacidade = consulta somente leitura; reserva/baixa ocorre só na finalização, na empresa selecionada. |
| D-06 | Capacidade **nunca** soma saldos entre empresas. |
| D-07 | Com ficha técnica: a empresa só atende se **todos** os ingredientes (convertidos) cobrirem a quantidade solicitada **naquela empresa**. |
| D-08 | Sem ficha: capacidade pelo saldo do próprio produto (se controla estoque); se não controla, o item não restringe. |
| D-09 | Alteração de carrinho (item/qtd) invalida snapshot de seleção; exige recalcular antes de finalizar. |
| D-10 | `X-Empresa-Id` do cliente **não** pode sobrescrever silenciosamente a empresa escolhida pelo seletor no fluxo com seletor ativo (ver integração §7). |
| D-11 | Falha de estoque/ficha na finalização → abortar; não concluir venda inconsistente. |
| D-12 | Mensagem de bloqueio deve indicar que **nenhuma empresa** atendeu o pedido completo (e, se útil, gargalos da matriz e da melhor tentativa) — sem sugerir split. |

### 4.2 Decisões pendentes de aprovação (Product Owner / Tech Lead)

| ID | Tema | Por que está pendente | Opções candidatas (não escolhidas) |
|---|---|---|---|
| **P-01** | Matriz ambígua ou ausente | Código atual exige seleção explícita em Central; PO não definiu comportamento no PDV | (a) Bloquear PDV até configurar matriz; (b) Usar só filiais elegíveis na ordem D-04; (c) Exigir escolha manual excepcional só da matriz |
| **P-02** | Fiscal obrigatório para elegibilidade | PO exige NFC-e de um CNPJ, mas nem toda venda emite na hora | (a) Exigir fiscal válido só se o fluxo pedir emissão; (b) Sempre exigir config fiscal mínima para entrar na seleção |
| **P-03** | Desempate “melhor estoque” | PO pediu determinismo; “maior capacidade” não foi definido | Manter só `id ASC` (D-04) **ou** ordenar por maior folga de estoque (precisa métrica) |
| **P-04** | Visibilidade da empresa escolhida na UI | R3 diz automático; 03.01 ainda tem seletor de contexto | (a) Remover escolha manual no PDV; (b) Manter seletor só informativo; (c) Permitir override administrativo com auditoria |
| **P-05** | Caixa aberto em outra empresa | Caixa é por `empresa_id`; seletor pode escolher empresa sem caixa do operador | (a) Empresa sem caixa aberto = inelegível; (b) Abrir/selecionar caixa automaticamente; (c) Bloquear com mensagem pedindo caixa na empresa X |
| **P-06** | Tipo de saldo (fiscal vs não fiscal) na capacidade | `consultarDisponibilidade` distingue saldos | (a) Usar o mesmo tipo que a venda/reserva usará na finalização; (b) Exigir ambos |
| **P-07** | Texto UX exato do bloqueio (R10) | Só há requisito de “mensagem clara” | Copy final marketing/ops |
| **P-08** | Produtos por peso/volume com tolerância | 03.01: conversão UN/PESO/VOLUME sobre quantidade | (a) Comparação estrita com precisão de estoque existente (`roundStockQuantity`); (b) Tolerância percentual — **não inventar** sem PO |
| **P-09** | EMPRESA_SIMPLES | Modo sem multiempresa | Seletor automático **não se aplica**; mantém contrato operacional de empresa única (fora do algoritmo matriz→filiais) |

Enquanto P-01…P-08 não forem aprovados, a implementação futura deve **falhar fechado** (bloquear ou usar apenas as decisões D-* já homologadas), sem improvisar regra de negócio.

---

## 5. Contrato conceitual do serviço de capacidade

**Nome proposto:** `ServicoCapacidadeCarrinhoEmpresa` (nome interno; sprint MUV-CAP-01)  
**Natureza:** somente leitura; **não** cria reserva, venda, financeiro nem fiscal.

### 5.1 Entrada conceitual

```text
AvaliarCapacidadeCarrinhoEntrada {
  usuarioId: number
  itens: Array<{
    produtoId: number
    quantidade: number          // já na unidade de venda do item
    unidade?: string            // UN | KG | L | … conforme cadastro
  }>
  exigirFiscalValido?: boolean  // depende de P-02 / fluxo
  tipoSaldo?: 'FISCAL' | 'NAO_FISCAL'  // depende de P-06
  // NÃO inclui empresaId “desejada” pelo cliente como autoridade
}
```

### 5.2 Avaliação por empresa (por item)

Para cada empresa candidata `E` e cada item `I`:

1. Se produto inexistente/inativo → `atendeItem = false`, motivo `PRODUTO_INDISPONIVEL`.
2. Se `utiliza_ficha_tecnica`:
   - Expandir ficha (componentes × quantidade do item), converter unidades (mesmas regras de `FichaTecnicaConsumoService`).
   - Para cada insumo: `disponivel(E, insumo)` via leitura alinhada a `estoque_empresa` / disponibilidade existente (descontando reservas ativas de terceiros conforme regras atuais).
   - `capacidadeItem = min floor(disponivel_insumo / necessidade_por_unidade)` (ou equivalência contínua com a precisão de estoque — **P-08**).
   - `atendeItem = capacidadeItem >= quantidade pedida`.
3. Se **não** usa ficha:
   - Se não controla estoque → `atendeItem = true` (sem gargalo de saldo).
   - Senão → `disponivel(E, produto)` ≥ quantidade pedida.
4. Gargalos: listar produto/insumo, necessário, disponível, déficit.

**Carrinho em E:** `atendeCarrinho = AND(atendeItem)` para todos os itens.  
**Proibido:** somar disponibilidade de E1+E2.

### 5.3 Saída conceitual

```text
AvaliarCapacidadeCarrinhoSaida {
  matrizId: number | null
  ordemAvaliacao: number[]          // ids na ordem efetivamente usada
  porEmpresa: Array<{
    empresaId: number
    tipo: 'MATRIZ' | 'FILIAL'
    elegivel: boolean
    atendeIntegralmente: boolean
    capacidadeMaximaPorItem: Array<{ produtoId, maxima }>  // quando aplicável
    gargalos: Array<{
      produtoId?, insumoId?, necessario, disponivel, unidade, codigoMotivo
    }>
    motivosInelegibilidade: string[]  // INATIVA, SEM_ACESSO, FISCAL_INVALIDO, …
  }>
  selecionada: {
    empresaId: number
    justificativa: string           // ex.: MATRIZ_ATENDE | FILIAL_ORDEM_ID
  } | null
  bloqueio: {
    codigo: 'NENHUMA_EMPRESA_ATENDE' | 'MATRIZ_AMBIGUA' | …
    mensagem: string
  } | null
  meta: {
    consultadoEm: string            // ISO
    hashCarrinho: string            // para invalidar seleção se carrinho mudar
    aviso: 'CONSULTA_NAO_RESERVA'   // sempre
  }
}
```

### 5.4 Seleção (camada de política sobre a capacidade)

Função conceitual `selecionarEmpresa(saidaCapacidade) → selecionada | bloqueio` implementa §3.  
Deve ser **pura** e testável com fixtures (cenários §8).

---

## 6. Reserva, concorrência e revalidação

| Momento | Obrigação |
|---|---|
| Consulta | Não grava reserva; resultado pode ficar stale |
| Pré-finalização | Recalcular se `hashCarrinho` mudou (**cenário 6**) |
| Finalização | Revalidar `atendeIntegralmente` na **empresa selecionada**; em seguida reservar e/ou debitar com as primitivas oficiais daquela empresa |
| Corrida (cenário 5) | Se o saldo não cobrir mais → **falhar** a finalização; não usar snapshot antigo como autorização |
| Pós-sucesso | Venda, itens, estoque, caixa, financeiro e fiscal usam o mesmo `empresa_id` |

**Requisito de atomicidade:** a conclusão da venda na empresa selecionada deve impedir consumo duplo inconsistente (transação / reserva existente do núcleo). Detalhe de API (reutilizar `reservasPublico` no PDV Normal vs débito direto atual) fica para sprints de implementação (**PDV-SEL-01**), sem alterar produção agora.

**Caixa (P-05):** até aprovação, a especificação exige apenas: a empresa selecionada e a sessão de caixa da venda devem ser **a mesma**; incompatibilidade → bloqueio, não troca silenciosa de empresa.

---

## 7. Integração planejada com o PDV oficial

### 7.1 Pontos previstos (sem implementar)

| Etapa | Onde (atual) | Mudança futura |
|---|---|---|
| Montagem do carrinho | `frontend/pdv/js/pdv.js` | Continua sem `empresa_id` por item |
| Pré-seleção (opcional UX) | novo endpoint de capacidade | Exibir empresa sugerida / bloqueio antecipado |
| Finalização | `enviarVenda` → `POST /api/vendas` | Enviar carrinho; **servidor** seleciona/revalida empresa |
| Resolução de empresa | hoje: `exigirEmpresaDaOperacao(req)` / `X-Empresa-Id` | Com seletor ativo: empresa da política **prevalece**; header do cliente não sobrescreve em silêncio (D-10) |
| Persistência | `VendaPagamentoService` | Mantém um `vendas.empresa_id`; estoque/ficha/financeiro/fiscal iguais |
| Universal | `/pdv-universal` | **Não** integrar; permanece congelado / fora do oficial |

### 7.2 Requisitos de integração

1. Seleção **antes** da persistência definitiva da venda.  
2. Cliente **não** redefine a empresa por item nem força outra empresa sem regra explícita (P-04).  
3. Revalidação na finalização na empresa escolhida.  
4. Vínculo único venda → estoque → pagamento → caixa → financeiro → fiscal.  
5. Mudança de carrinho → invalidar seleção (`hashCarrinho`).  
6. Falha de estoque → não concluir venda inconsistente.  
7. Em `EMPRESA_SIMPLES` (P-09): seletor desligado; comportamento atual de empresa única.

### 7.3 Compatibilidade com o seletor atual `CdsEmpresaContexto`

Hoje o operador escolhe a empresa. Com a política ativa, o contexto deixa de ser a **fonte da verdade** da venda no PDV. A transição (esconder seletor, modo só leitura, override admin) depende de **P-04** e não será improvisada.

---

## 8. Cenários de aceite (resultados esperados verificáveis)

| # | Cenário | Resultado esperado |
|---|---|---|
| 1 | Matriz atende; filiais também | Selecionar **matriz**. Justificativa `MATRIZ_ATENDE`. |
| 2 | Matriz não atende; uma ou mais filiais atendem | Selecionar **uma** filial pela ordem D-04. Sem split. |
| 3 | Soma entre empresas bastaria; nenhuma atende sozinha | `selecionada = null`, bloqueio `NENHUMA_EMPRESA_ATENDE`. Não criar venda. |
| 4 | Empresa tem produto, mas falta ingrediente da ficha | Essa empresa `atendeIntegralmente = false` com gargalo de insumo. |
| 5 | Estoque muda após consulta | Finalização revalida; se insuficiente, falha; snapshot não autoriza consumo. |
| 6 | Carrinho alterado após seleção | `hashCarrinho` diverge → recalcular; seleção anterior inválida. |
| 7 | Nenhuma elegível / nenhuma capaz / matriz ambígua (se P-01 = bloquear) | Bloquear finalização com motivo explícito. |
| 8 | Integridade | Única `empresa_id` em venda, itens (dono), estoque, pagamentos/caixa, financeiro e contexto fiscal/NFC-e. |

Fixtures de teste (futuro PDV-SEL-02) devem cobrir 1–8 em banco `:memory:` / isolado, **sem** SEFAZ real.

---

## 9. Riscos e compatibilidade

| Risco | Impacto | Mitigação planejada |
|---|---|---|
| Confundir Universal/MUV com o PDV oficial | Split multi-CNPJ contradiz R7–R9 | Escopo D-01; GOV-01 |
| `X-Empresa-Id` vs seletor | Venda na empresa “errada” | D-10; prevalência servidor |
| Caixa em empresa diferente da selecionada | Falha operacional | P-05 |
| Consulta stale | Over-selling | §6 revalidação + reserva/transação |
| Ficha sem API de “unidades produzíveis” | Capacidade incompleta | MUV-CAP-01 deriva da mesma lógica de consumo |
| Ordenação só por `id` | PO pode querer outra ordem | P-03; D-04 como v1 homologável |
| Doc 03.01 descreve escolha manual | Drift documental | Atualizar 03.01 na sprint de integração |

---

## 10. Próximas sprints (escopo isolado — **não iniciadas**)

| Sprint | Escopo | Entrega | Fora de escopo |
|---|---|---|---|
| **MUV-CAP-01** | Serviço somente leitura de capacidade + seleção pura | API/serviço interno + testes unitários dos cenários 1–4, 7 | Sem plugar no PDV; sem reserva |
| **PDV-SEL-01** | Integrar seletor ao `/pdv` → `POST /api/vendas` | Prevalência da empresa selecionada; bloqueio R10; revalidação | Sem Universal; sem mudar fiscal SEFAZ |
| **PDV-SEL-02** | Testes de aceitação isolados | Cenários 1–8 + concorrência 5 + hash 6 | Sem banco de cliente |
| **GOV-01** | Governança | Atualizar docs 03.01; declarar Universal incompatível com esta política como caminho oficial | Sem reativar Universal |
| **UX-SEL-01** (após P-04/P-07) | Mensagens e UI | Copy de bloqueio; eventual remoção/ajuste do seletor | Sem regra de negócio nova |

---

## 11. Critério de encerramento desta sprint

- [x] Documento criado em `docs/arquitetura/ESPECIFICACAO_SELECAO_AUTOMATICA_EMPRESA_MUV_02.md`
- [x] Decisões definidas (D-01…D-12) e pendentes (P-01…P-09) explícitas
- [x] Oito cenários com resultados esperados verificáveis
- [x] Contrato conceitual de capacidade separado de reserva
- [x] Integração planejada com PDV oficial; Universal excluído
- [x] Nenhuma alteração de código de produção, testes, banco ou SEFAZ

**Status:** AUD/SPEC-MUV-02 concluída. Aguardando homologação do Tech Lead e aprovações do Product Owner nas pendências P-*. Não iniciar implementação automaticamente.
