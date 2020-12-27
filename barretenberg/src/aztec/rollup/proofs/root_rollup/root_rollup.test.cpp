#include "../../fixtures/user_context.hpp"
#include "../../constants.hpp"
#include "../rollup/verify.hpp"
#include "../join_split/create_noop_join_split_proof.hpp"
#include "compute_or_load_fixture.hpp"
#include "compute_circuit_data.hpp"
#include "root_rollup_circuit.hpp"
#include "create_root_rollup_tx.hpp"
#include "verify.hpp"
#include <common/test.hpp>

namespace rollup {
namespace proofs {
namespace root_rollup {

// Uncomment to simulate running in CI.
// #define DISABLE_HEAVY_TESTS

#ifdef DISABLE_HEAVY_TESTS
constexpr auto REQUIRE_KEYS = false;
#else
constexpr auto REQUIRE_KEYS = true;
#endif

using namespace barretenberg;
using namespace notes::native;
using namespace plonk::stdlib::merkle_tree;

numeric::random::Engine* rand_engine = &numeric::random::get_debug_engine(true);
fixtures::user_context user = fixtures::create_user_context(rand_engine);
join_split::circuit_data join_split_cd;
account::circuit_data account_cd;
rollup::circuit_data tx_rollup_cd;
circuit_data root_rollup_cd;
std::vector<std::vector<uint8_t>> js_proofs;

class root_rollup_tests : public ::testing::Test {
  protected:
    static constexpr auto FIXTURE_PATH = "../src/aztec/rollup/proofs/root_rollup/fixtures";
    static constexpr auto TEST_PROOFS_PATH = "../src/aztec/rollup/proofs/root_rollup/fixtures/test_proofs";
    static constexpr auto INNER_ROLLUP_TXS = 2U;
    static constexpr auto ROLLUPS_PER_ROLLUP = 3U;

    typedef std::vector<std::vector<std::vector<uint8_t>>> RollupStructure;

    root_rollup_tests()
        : data_tree(store, DATA_TREE_DEPTH, 0)
        , null_tree(store, NULL_TREE_DEPTH, 1)
        , root_tree(store, ROOT_TREE_DEPTH, 2)
    {
        update_root_tree_with_data_root(0);
        rand_engine = &numeric::random::get_debug_engine(true);
        user = fixtures::create_user_context(rand_engine);
    }

    static void SetUpTestCase()
    {
        std::string crs_path = "../srs_db/ignition";

        if (REQUIRE_KEYS) {
            account_cd = account::compute_or_load_circuit_data(crs_path, FIXTURE_PATH);
            join_split_cd = join_split::compute_or_load_circuit_data(crs_path, FIXTURE_PATH);
            tx_rollup_cd = rollup::get_circuit_data(
                INNER_ROLLUP_TXS, join_split_cd, account_cd, crs_path, FIXTURE_PATH, true, true, true);
            root_rollup_cd =
                get_circuit_data(ROLLUPS_PER_ROLLUP, tx_rollup_cd, crs_path, FIXTURE_PATH, true, true, true);
        } else {
            tx_rollup_cd = rollup::get_circuit_data(
                INNER_ROLLUP_TXS, join_split_cd, account_cd, crs_path, FIXTURE_PATH, false, false, true);
            root_rollup_cd =
                get_circuit_data(ROLLUPS_PER_ROLLUP, tx_rollup_cd, crs_path, FIXTURE_PATH, false, false, true);
        }

        MemoryStore store;
        MerkleTree<MemoryStore> data_tree(store, DATA_TREE_DEPTH, 0);
        // Create 5 js proofs to play with.
        for (size_t i = 0; i < 5; ++i) {
            auto js_proof = compute_or_load_fixture(TEST_PROOFS_PATH, format("js", i), [&] {
                return create_noop_join_split_proof(join_split_cd, data_tree.root());
            });
            js_proofs.push_back(js_proof);
        }
    }

    root_rollup_tx create_root_rollup_tx(std::string const& test_name,
                                         uint32_t rollup_id,
                                         RollupStructure const& rollup_structure)
    {
        std::vector<rollup::rollup_tx> rollups;
        std::vector<std::vector<uint8_t>> rollups_data;

        for (auto tx_proofs : rollup_structure) {
            auto name = format(test_name, "_rollup", rollups.size() + 1);
            auto rollup = create_rollup_tx(tx_proofs);
            auto rollup_data = compute_or_load_rollup(name, rollup);
            ASSERT(!rollup_data.empty());
            rollups.push_back(rollup);
            rollups_data.push_back(rollup_data);
        }

        return root_rollup::create_root_rollup_tx(rollup_id, rollups_data, data_tree, root_tree);
    }

    void update_root_tree_with_data_root(size_t index)
    {
        auto data_root = to_buffer(data_tree.root());
        root_tree.update_element(index, data_root);
    }

    std::vector<uint8_t> compute_or_load_rollup(std::string const& name, rollup::rollup_tx& rollup)
    {
        return compute_or_load_fixture(
            TEST_PROOFS_PATH, name, [&] { return rollup::verify_rollup(rollup, tx_rollup_cd).proof_data; });
    }

    rollup::rollup_tx create_rollup_tx(std::vector<std::vector<uint8_t>> const& txs)
    {
        return rollup::create_rollup(txs, data_tree, null_tree, root_tree, INNER_ROLLUP_TXS);
    }

    MemoryStore store;
    MerkleTree<MemoryStore> data_tree;
    MerkleTree<MemoryStore> null_tree;
    MerkleTree<MemoryStore> root_tree;
};

/*
 * The fixtures names are named so as to reduce unnecessary (re)computation.
 * i.e. If a rollup has a structure shorter than its name suggests, it's because it can reuse the fixtures from
 * the longer rollup structure due to them having the same leading structure.
 */
TEST_F(root_rollup_tests, test_root_rollup_1_real_2_padding)
{
    auto tx_data = create_root_rollup_tx("root_1", 0, { { js_proofs[0] } });
    auto verified = verify_logic(tx_data, root_rollup_cd);
    ASSERT_TRUE(verified);
}

TEST_F(root_rollup_tests, test_root_rollup_2_real_1_padding)
{
    auto tx_data = create_root_rollup_tx("root_211", 0, { { js_proofs[0], js_proofs[1] }, { js_proofs[2] } });
    auto verified = verify_logic(tx_data, root_rollup_cd);
    ASSERT_TRUE(verified);
}

TEST_F(root_rollup_tests, test_root_rollup_3_real_0_padding)
{
    auto tx_data = create_root_rollup_tx(
        "root_221", 0, { { js_proofs[0], js_proofs[1] }, { js_proofs[2], js_proofs[3] }, { js_proofs[4] } });
    auto verified = verify_logic(tx_data, root_rollup_cd);
    ASSERT_TRUE(verified);
}

TEST_F(root_rollup_tests, test_incorrect_new_data_root_fails)
{
    auto tx_data = create_root_rollup_tx("bad_new_data_root_fail", 0, { { js_proofs[0] } });
    tx_data.new_data_roots_root = fr::random_element();
    auto verified = verify_logic(tx_data, root_rollup_cd);
    ASSERT_FALSE(verified);
}

TEST_F(root_rollup_tests, test_partial_inner_rollup_not_last_fail)
{
    auto tx_data =
        create_root_rollup_tx("root_211", 0, { { js_proofs[0], js_proofs[1] }, { js_proofs[2] }, { js_proofs[3] } });
    auto verified = verify_logic(tx_data, root_rollup_cd);
    ASSERT_FALSE(verified);
}

TEST_F(root_rollup_tests, test_inner_rollups_out_of_order_fail)
{
    auto tx_data =
        create_root_rollup_tx("root_221", 0, { { js_proofs[0], js_proofs[1] }, { js_proofs[2], js_proofs[3] } });
    std::swap(tx_data.rollups[0], tx_data.rollups[1]);

    auto verified = verify_logic(tx_data, root_rollup_cd);
    ASSERT_FALSE(verified);
}

TEST_F(root_rollup_tests, test_invalid_padding_proof_fail)
{
    auto tx_data = create_root_rollup_tx(
        "root_221", 0, { { js_proofs[0], js_proofs[1] }, { js_proofs[2], js_proofs[3] }, { js_proofs[4] } });
    tx_data.num_inner_proofs = 2;
    auto verified = verify_logic(tx_data, root_rollup_cd);
    ASSERT_FALSE(verified);
}

TEST_F(root_rollup_tests, test_invalid_last_proof_fail)
{
    auto tx_data = create_root_rollup_tx("root_221", 0, { { js_proofs[0], js_proofs[1] } });
    tx_data.num_inner_proofs = 2;
    auto verified = verify_logic(tx_data, root_rollup_cd);
    ASSERT_FALSE(verified);
}

HEAVY_TEST_F(root_rollup_tests, test_root_rollup_full)
{
    auto old_data_root = data_tree.root();
    auto old_null_root = null_tree.root();
    auto old_root_root = root_tree.root();

    auto tx_data = create_root_rollup_tx("root_211", 0, { { js_proofs[0], js_proofs[1] }, { js_proofs[2] } });
    auto result = verify(tx_data, root_rollup_cd);
    ASSERT_TRUE(result.verified);

    auto rollup_data = rollup::rollup_proof_data(result.proof_data);
    EXPECT_EQ(rollup_data.rollup_id, 0U);
    EXPECT_EQ(rollup_data.rollup_size, INNER_ROLLUP_TXS * ROLLUPS_PER_ROLLUP);
    EXPECT_EQ(rollup_data.data_start_index, 0U);
    EXPECT_EQ(rollup_data.old_data_root, old_data_root);
    EXPECT_EQ(rollup_data.old_null_root, old_null_root);
    EXPECT_EQ(rollup_data.old_data_roots_root, old_root_root);
    EXPECT_EQ(rollup_data.new_data_root, data_tree.root());
    EXPECT_EQ(rollup_data.new_null_root, null_tree.root());
    EXPECT_EQ(rollup_data.new_data_roots_root, root_tree.root());
    EXPECT_EQ(rollup_data.num_txs, 3U);
}

// Waiting on fix, then delete.
HEAVY_TEST_F(root_rollup_tests, minimal_failing_test)
{
    auto rollup1 = create_rollup_tx({ js_proofs[0] });
    auto rollup1_proof_data = compute_or_load_rollup(format("min_fail_rollup", INNER_ROLLUP_TXS), rollup1);
    ASSERT_TRUE(!rollup1_proof_data.empty());

    Composer composer("../srs_db/ignition");
    auto recursive_manifest = Composer::create_unrolled_manifest(tx_rollup_cd.verification_key->num_public_inputs);

    recursion_output<bn254> recursion_output;
    auto recursive_verification_key =
        plonk::stdlib::recursion::verification_key<bn254>::from_witness(&composer, tx_rollup_cd.verification_key);

    recursion_output =
        verify_proof<bn254, recursive_turbo_verifier_settings<bn254>>(&composer,
                                                                      recursive_verification_key,
                                                                      recursive_manifest,
                                                                      waffle::plonk_proof{ rollup1_proof_data },
                                                                      recursion_output);

    auto verified = pairing_check(recursion_output, tx_rollup_cd.verification_key);

    EXPECT_TRUE(verified);
}

} // namespace root_rollup
} // namespace proofs
} // namespace rollup