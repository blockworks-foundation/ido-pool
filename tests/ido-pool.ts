import * as anchor from "@project-serum/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { expect } from 'chai';
import * as fs from "fs";
import * as utils from "./utils";

// const {
//   TOKEN_PROGRAM_ID,
//   sleep,
//   getTokenAccount,
//   createMint,
//   createTokenAccount,
//   mintToAccount,
// } = require("./utils");

describe("ido-pool", () => {
  const programId = new anchor.web3.PublicKey("idosCTwC7fvCbnnzhpWqbnmTWsNwsVy2cPBjioKEZeo");
  const idl = JSON.parse(fs.readFileSync("./target/idl/ido_pool.json").toString());

  let key = JSON.parse(fs.readFileSync(process.env.MY_WALLET, "utf8"));

  const myWallet = anchor.web3.Keypair.fromSecretKey(new Uint8Array(key));

  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com/",
    "confirmed"
  );

  const walletWrapper = new anchor.Wallet(myWallet);
  const provider = new anchor.Provider(connection, walletWrapper, {
    preflightCommitment: "recent",
  });
  const program = new anchor.Program(idl, programId, provider);

  // All mints default to 6 decimal places.
  const watermelonIdoAmount = new anchor.BN(5000000);

  // These are all of the variables we assume exist in the world already and
  // are available to the client.
  let usdcMint: PublicKey = null;
  let watermelonMint: PublicKey = null;
  let creatorUsdc: PublicKey = null;
  let creatorWatermelon: PublicKey = null;

  it("Initializes the state-of-the-world", async () => {
    usdcMint = await utils.createMint(provider, provider.wallet.publicKey);
    watermelonMint = await utils.createMint(provider, provider.wallet.publicKey);
    creatorUsdc = await utils.createTokenAccount(
      provider,
      usdcMint,
      provider.wallet.publicKey
    );
    creatorWatermelon = await utils.createTokenAccount(
      provider,
      watermelonMint,
      provider.wallet.publicKey
    );
    // Mint Watermelon tokens the will be distributed from the IDO pool.
    await utils.mintToAccount(
      provider,
      watermelonMint,
      creatorWatermelon,
      watermelonIdoAmount,
      provider.wallet.publicKey
    );
    let creator_watermelon_account = await utils.getTokenAccount(
      provider,
      creatorWatermelon
    );
    expect(creator_watermelon_account.amount).to.eq(watermelonIdoAmount);
  });

  // These are all variables the client will have to create to initialize the
  // IDO pool
  let poolSigner = null;
  let redeemableMint = null;
  let poolWatermelon = null;
  let poolUsdc = null;
  let poolAccount = null;

  let startIdoTs = null;
  let endDepositsTs = null;
  let endIdoTs = null;

  it("Initializes the IDO pool", async () => {
    // We use the watermelon mint address as the seed, could use something else though.
    const [_poolSigner, nonce] = await anchor.web3.PublicKey.findProgramAddress(
      [watermelonMint.toBuffer()],
      program.programId
    );
    poolSigner = _poolSigner;

    // Pool doesn't need a Redeemable SPL token account because it only
    // burns and mints redeemable tokens, it never stores them.
    redeemableMint = await utils.createMint(provider, poolSigner);
    poolWatermelon = await utils.createTokenAccount(
      provider,
      watermelonMint,
      poolSigner
    );
    poolUsdc = await utils.createTokenAccount(provider, usdcMint, poolSigner);

    poolAccount = anchor.web3.Keypair.generate();
    const nowBn = new anchor.BN(Date.now() / 1000);
    startIdoTs = nowBn.add(new anchor.BN(5));
    endDepositsTs = nowBn.add(new anchor.BN(10));
    endIdoTs = nowBn.add(new anchor.BN(15));

    // Atomically create the new account and initialize it with the program.
    await program.rpc.initializePool(
      watermelonIdoAmount,
      nonce,
      startIdoTs,
      endDepositsTs,
      endIdoTs,
      {
        accounts: {
          poolAccount: poolAccount.publicKey,
          poolSigner,
          distributionAuthority: provider.wallet.publicKey,
          creatorWatermelon,
          redeemableMint,
          usdcMint,
          poolWatermelon,
          poolUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        },
        signers: [poolAccount],
        instructions: [
          await program.account.poolAccount.createInstruction(poolAccount),
        ],
      }
    );

    let creators_watermelon_account = await poolWatermelon.getTokenAccount(
      provider,
      creatorWatermelon
    );
    expect(creators_watermelon_account.amount).to.eq(new anchor.BN(0));
  });

  // We're going to need to start using the associated program account for creating token accounts
  // if not in testing, then definitely in production.

  let userUsdc = null;
  let userRedeemable = null;
  // 10 usdc
  const firstDeposit = new anchor.BN(10_000_349);

  it("Exchanges user USDC for redeemable tokens", async () => {
    // Wait until the IDO has opened.
    if (Date.now() < startIdoTs.toNumber() * 1000) {
      await utils.sleep(startIdoTs.toNumber() * 1000 - Date.now() + 1000);
    }

    userUsdc = await utils.createTokenAccount(
      provider,
      usdcMint,
      provider.wallet.publicKey
    );
    await utils.mintToAccount(
      provider,
      usdcMint,
      userUsdc,
      firstDeposit,
      provider.wallet.publicKey
    );
    userRedeemable = await utils.createTokenAccount(
      provider,
      redeemableMint,
      provider.wallet.publicKey
    );

    try {
      const tx = await program.rpc.exchangeUsdcForRedeemable(firstDeposit, {
        accounts: {
          poolAccount: poolAccount.publicKey,
          poolSigner,
          redeemableMint,
          poolUsdc,
          userAuthority: provider.wallet.publicKey,
          userUsdc,
          userRedeemable,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        },
      });
    } catch (err) {
      console.log("This is the error message", err.toString());
    }
    let poolUsdcAccount = await utils.getTokenAccount(provider, poolUsdc);
    expect(poolUsdcAccount.amount).to.eq(firstDeposit);
    let userRedeemableAccount = await utils.getTokenAccount(provider, userRedeemable);
    expect(userRedeemableAccount.amount).to.eq(firstDeposit);
  });

  // 23 usdc
  const secondDeposit = new anchor.BN(23_000_672);
  let totalPoolUsdc = null;

  it("Exchanges a second users USDC for redeemable tokens", async () => {
    let secondUserUsdc = await utils.createTokenAccount(
      provider,
      usdcMint,
      provider.wallet.publicKey
    );
    await utils.mintToAccount(
      provider,
      usdcMint,
      secondUserUsdc,
      secondDeposit,
      provider.wallet.publicKey
    );
    let secondUserRedeemable = await utils.createTokenAccount(
      provider,
      redeemableMint,
      provider.wallet.publicKey
    );

    await program.rpc.exchangeUsdcForRedeemable(secondDeposit, {
      accounts: {
        poolAccount: poolAccount.publicKey,
        poolSigner,
        redeemableMint,
        poolUsdc,
        userAuthority: provider.wallet.publicKey,
        userUsdc: secondUserUsdc,
        userRedeemable: secondUserRedeemable,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
    });

    totalPoolUsdc = firstDeposit.add(secondDeposit);
    let poolUsdcAccount = await utils.getTokenAccount(provider, poolUsdc);
    expect(poolUsdcAccount.amount).to.eq(totalPoolUsdc);
    let secondUserRedeemableAccount = await utils.getTokenAccount(
      provider,
      secondUserRedeemable
    );
    expect(secondUserRedeemableAccount.amount).to.eq(secondDeposit);
  });

  const firstWithdrawal = new anchor.BN(2_000_000);

  it("Exchanges user Redeemable tokens for USDC", async () => {
    await program.rpc.exchangeRedeemableForUsdc(firstWithdrawal, {
      accounts: {
        poolAccount: poolAccount.publicKey,
        poolSigner,
        redeemableMint,
        poolUsdc,
        userAuthority: provider.wallet.publicKey,
        userUsdc,
        userRedeemable,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
    });

    totalPoolUsdc = totalPoolUsdc.sub(firstWithdrawal);
    let poolUsdcAccount = await utils.getTokenAccount(provider, poolUsdc);
    expect(poolUsdcAccount.amount).to.eq(totalPoolUsdc);
    let userUsdcAccount = await utils.getTokenAccount(provider, userUsdc);
    expect(userUsdcAccount.amount).to.eq(firstWithdrawal);
  });

  it("Exchanges user Redeemable tokens for watermelon", async () => {
    // Wait until the IDO has opened.
    if (Date.now() < endIdoTs.toNumber() * 1000) {
      await utils.sleep(endIdoTs.toNumber() * 1000 - Date.now() + 2000);
    }
    let firstUserRedeemable = firstDeposit.sub(firstWithdrawal);
    let userWatermelon = await utils.createTokenAccount(
      provider,
      watermelonMint,
      provider.wallet.publicKey
    );

    await program.rpc.exchangeRedeemableForWatermelon(firstUserRedeemable, {
      accounts: {
        poolAccount: poolAccount.publicKey,
        poolSigner,
        redeemableMint,
        poolWatermelon,
        userAuthority: provider.wallet.publicKey,
        userWatermelon,
        userRedeemable,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
    });

    let poolWatermelonAccount = await utils.getTokenAccount(provider, poolWatermelon);
    let redeemedWatermelon = firstUserRedeemable
      .mul(watermelonIdoAmount)
      .div(totalPoolUsdc);
    let remainingWatermelon = watermelonIdoAmount.sub(redeemedWatermelon);
    expect(poolWatermelonAccount.amount).to.eq(remainingWatermelon);
    let userWatermelonAccount = await utils.getTokenAccount(provider, userWatermelon);
    expect(userWatermelonAccount.amount).to.eq(redeemedWatermelon);
  });

  it("Exchanges second users Redeemable tokens for watermelon", async () => {
    let secondUserWatermelon = await utils.createTokenAccount(
      provider,
      watermelonMint,
      provider.wallet.publicKey
    );

    let secondUserRedeemable = await utils.createTokenAccount(
      provider,
      redeemableMint,
      provider.wallet.publicKey
    );

    await program.rpc.exchangeRedeemableForWatermelon(secondDeposit, {
      accounts: {
        poolAccount: poolAccount.publicKey,
        poolSigner,
        redeemableMint,
        poolWatermelon,
        userAuthority: provider.wallet.publicKey,
        userWatermelon: secondUserWatermelon,
        userRedeemable: secondUserRedeemable,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
    });

    let poolWatermelonAccount = await utils.getTokenAccount(provider, poolWatermelon);
    expect(poolWatermelonAccount.amount).to.eq(new anchor.BN(0));
  });

  it("Withdraws total USDC from pool account", async () => {
    await program.rpc.withdrawPoolUsdc({
      accounts: {
        poolAccount: poolAccount.publicKey,
        poolSigner,
        distributionAuthority: provider.wallet.publicKey,
        creatorUsdc,
        poolUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
    });

    let poolUsdcAccount = await utils.getTokenAccount(provider, poolUsdc);
    expect(poolUsdcAccount.amount).to.eq(new anchor.BN(0));
    let creatorUsdcAccount = await utils.getTokenAccount(provider, creatorUsdc);
    expect(creatorUsdcAccount.amount).to.eq(totalPoolUsdc);
  });
});
