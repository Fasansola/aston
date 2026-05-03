<?php
/**
 * Aston VIP Blog Tool — Polylang language REST endpoint
 *
 * Add this to your theme's functions.php or a site-specific plugin.
 *
 * Registers POST /wp-json/aston/v1/set-post-language
 * Called automatically by the blog tool after every post is created
 * to assign the correct Polylang language to the draft.
 *
 * Works with both Polylang Free and Polylang Pro.
 */

add_action( 'rest_api_init', function () {
    register_rest_route( 'aston/v1', '/set-post-language', [
        'methods'             => 'POST',
        'permission_callback' => function () {
            return current_user_can( 'edit_posts' );
        },
        'args' => [
            'post_id' => [
                'required'          => true,
                'type'              => 'integer',
                'sanitize_callback' => 'absint',
            ],
            'lang' => [
                'required'          => true,
                'type'              => 'string',
                'sanitize_callback' => 'sanitize_key',
            ],
        ],
        'callback' => function ( WP_REST_Request $request ) {
            $post_id = $request->get_param( 'post_id' );
            $lang    = $request->get_param( 'lang' );

            if ( ! function_exists( 'pll_set_post_language' ) ) {
                return new WP_Error(
                    'polylang_not_active',
                    'Polylang is not active on this site.',
                    [ 'status' => 500 ]
                );
            }

            // Verify the language slug is registered in Polylang
            $languages = pll_languages_list( [ 'fields' => 'slug' ] );
            if ( ! in_array( $lang, $languages, true ) ) {
                return new WP_Error(
                    'invalid_language',
                    sprintf( 'Language "%s" is not registered in Polylang. Available: %s', $lang, implode( ', ', $languages ) ),
                    [ 'status' => 400 ]
                );
            }

            pll_set_post_language( $post_id, $lang );

            return [ 'success' => true, 'post_id' => $post_id, 'lang' => $lang ];
        },
    ] );
} );
